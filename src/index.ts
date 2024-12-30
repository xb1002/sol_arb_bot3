import { Connection,PublicKey,Keypair,AddressLookupTableAccount,TransactionInstruction,
  ComputeBudgetProgram,SystemProgram,TransactionMessage,VersionedTransaction
} from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { DefaultApi,QuoteGetRequest,QuoteGetSwapModeEnum,QuoteResponse,
  SwapRequest,createJupiterApiClient
} from "@jup-ag/api";
import "dotenv/config";
import * as config from "./config.js";
import winston, { add } from "winston";
import bs58 from "bs58";
import WebSocket from 'ws';
import os from 'os';
import {createLogger} from "./lib/logger.js";
import { DB } from "./lib/db.js";
import {getPriorityFee,getMainBalance,priorityFeeResponse,selectPriorityFee,calculatePriorityLevel,
  instructionFormat
} from './lib/common.js';
import { WebSocketClient } from "./lib/ws.js";
import { sendTxToRpc,sendTxToBundle } from "./lib/sendTx.js";
import fs from 'fs';

// -------------------------------------------------


// -------------------------------------------------
// 日志配置
const logger = createLogger({service:'index'});

// -------------------------------------------------
// 读取环境变量
const RPC = process.env.RPC as string;
const WS_RPC = process.env.WS_RPC ? process.env.WS_RPC : 'wss://api.mainnet-beta.solana.com/'
const sendTxRpcs = process.env.SEND_TX_RPCS as string;
const jupiterApi = process.env.JUPITER_API as string;
const payer = Keypair.fromSecretKey(new Uint8Array(bs58.decode(process.env.SECRET_KEY as string)));

// 准备
const commitment = config.normalConfig.commitment;
const pubRPC = "https://api.mainnet-beta.solana.com";
const con = new Connection(RPC, commitment);
const sendTxCons = sendTxRpcs.split(",").map((rpc) => new Connection(rpc, commitment));
const pubCon = new Connection(pubRPC, commitment);
const jupCon = createJupiterApiClient({basePath:jupiterApi});

// -------------------------------------------------
// 按规定时间更新余额-->使用pubCon
let {symbol:mainSymbol,mint:mainMint} = config.trade_pairs.pair1;
var mainBalance = 0;
let ATA = await getAssociatedTokenAddress(new PublicKey(mainMint),payer.publicKey);
mainBalance = await getMainBalance(ATA,pubCon);
logger.debug(`mainBalance: ${mainBalance}`)
setInterval(() => {
  getMainBalance(ATA,pubCon).then((res) => {
      mainBalance = res;
  }).catch((error) => {
      logger.error(`get balance error: ${error}`);
  });
}, config.IntervalConfig.balanceInterval);


// -------------------------------------------------
// 按规定时间更新blockhash-->使用pubCon
var blockhash_list:string[] = [];
var blockhash = (await pubCon.getLatestBlockhash()).blockhash;
blockhash_list.push(blockhash);
setInterval(() => {
  pubCon.getLatestBlockhash().then((res) => {
      blockhash = res.blockhash;
      blockhash_list.push(blockhash);
      if (blockhash_list.length > config.normalConfig.txMutilpler) { // 保存多个blockhash，以便提出多个交易
          blockhash_list.shift();
      }
  }).catch((error) => {
      logger.error(`get blockhash error: ${error}`);
  });
}, config.IntervalConfig.blockhashInterval);


// -------------------------------------------------
// 按规定时间更新slot
var latestSlot = (await con.getSlot());
// 本地更新slot
setInterval(() => {
  latestSlot += 1;
}, config.IntervalConfig.updateSlotInterval);
// 从链上获取slot
setInterval(() => {
  con.getSlot().then((res) => {
      logger.debug(`latestSlotByGet ${res}, latestSlotByLocal ${latestSlot}`);
      latestSlot = res;
  }).catch((error) => {
      logger.error(`get latestSlot error: ${error}`);
  });
}, config.IntervalConfig.getSlotInterval);


// -------------------------------------------------
// 按规定时间更新优先费
var priorityFee = await getPriorityFee(RPC);
setInterval(() => {
  getPriorityFee(RPC).then((res) => {
      priorityFee = res;
  }).catch((error) => {
      logger.error(`get priorityFee error: ${error}`);
  });
}, config.IntervalConfig.priorityFeeInterval);


// -------------------------------------------------
// 保存地址查找表
var addressLookupTableList:AddressLookupTableAccount[] = [];

const wsUrl = WS_RPC;
let ws:WebSocketClient;

ws = new WebSocketClient(wsUrl);

// 每3min检查addressLookupTableList的account是否有操作，有则重新获取该account
setInterval(() => {
  ws.subscriptionData.map(async (item) => {
    if (item.method === 'accountSubscribe' && item.result?.slot) {
      let address = item.param
      let index = addressLookupTableList.findIndex((account) => account.key.toBase58() === address);
      if (index !== -1) {
          addressLookupTableList[index] = await con.getAddressLookupTable(new PublicKey(address)).then((res) => {
              return res.value as AddressLookupTableAccount;
          }).catch((error) => {
              logger.error(`get addressLookupTable error: ${error}`);
              return addressLookupTableList[index];
          });
    }}
  })
}, 3*60*1000);

// 设置地址查找表最大监听数量
setInterval(() => {
  if (addressLookupTableList.length > config.normalConfig.maxAddressLookupTableNum) {
      let address = addressLookupTableList[0].key.toBase58();
      ws.unsubscribe('accountUnsubscribe',address);
      addressLookupTableList.shift();
  }
}, config.IntervalConfig.adjustAddressLookupTableInterval);


// -------------------------------------------------
// 初始化套利参数
let minProfitBps = config.normalConfig.minProfitBps / 10000;
let partformFeeBps = config.normalConfig.partformFeeBps / 10000;
let minJitoTip = config.normalConfig.minJitoTip;
let trade_main = mainBalance * config.normalConfig.tradePercentageOfBalance;
let jitoFeePercentage = config.normalConfig.jitoFeePercentage;
let ifsendTxToBothRpcAndBundle= config.submitTxMethodConfig.ifsendTxToBothRpcAndBundle;
let ifsendTxByBundle = config.submitTxMethodConfig.ifsendTxByBundle;
const JitoTipAccounts = config.JitoTipAccounts;
const BundleApis = config.BundleApis;
let ifsendTxByJito = ifsendTxToBothRpcAndBundle || ifsendTxByBundle;

// const instructionFormat = instructionFormat;
// const sendTxToRpc = sendTxToRpc;
// const sendTxToBundle = sendTxToBundle;

interface monitorParams {
  pair1:config.TradePair,
  pair2:config.TradePair,
  con:Connection,
  jupCon:DefaultApi
}
async function monitor(params:monitorParams) {
  const {pair1,pair2,con,jupCon} = params;
  // 获取交易对信息
  const pair1_to_pair2 : QuoteGetRequest = {
      inputMint: pair1.mint,
      outputMint: pair2.mint,
      amount: Math.floor(trade_main),
      onlyDirectRoutes: config.normalConfig.directRoute,
      slippageBps: 0,
      maxAccounts: 28,
      swapMode: QuoteGetSwapModeEnum.ExactIn
  }
  const pair2_to_pair1 : QuoteGetRequest = {
      inputMint: pair2.mint,
      outputMint: pair1.mint,
      amount: Math.floor(trade_main),
      onlyDirectRoutes: config.normalConfig.directRoute,
      slippageBps: 0,
      swapMode: QuoteGetSwapModeEnum.ExactOut
  }
  try {
    let startRequestQuoteTime = Date.now();
    let quote0Resp:QuoteResponse;
    let quote1Resp:QuoteResponse;
    try {
        [quote0Resp ,quote1Resp] = await Promise.all([
          jupCon.quoteGet(pair1_to_pair2),
          jupCon.quoteGet(pair2_to_pair1)
      ]);
    } catch (error) {
        throw new Error(`get quote error: ${error}`);
    }
      logger.debug(`${pair1.symbol}-${pair2.symbol} get quote cost: ${Date.now() - startRequestQuoteTime}ms`);
      // 检查是否是同一个池
      if (config.judgementConfig.ifJudgeSamePool) {
          if (quote0Resp?.routePlan[0].swapInfo.ammKey === quote1Resp?.routePlan[0].swapInfo.ammKey) {
              logger.debug(`pairs: ${pair1.symbol} ${pair2.symbol}, same pool, return...`)
              return;
          }
      }
      // 检查contextslot是否太滞后
      if (config.judgementConfig.ifJudgeSlotLatency) {
          let slotTolerance = config.normalConfig.maxTolerantSlotNum;
          if (latestSlot-slotTolerance > Number(quote0Resp?.contextSlot) || latestSlot-slotTolerance > Number(quote1Resp?.contextSlot)) {
              logger.debug(`pairs: ${pair1.symbol} ${pair2.symbol}, latestSlot: ${latestSlot}, quote0 slot: ${quote0Resp?.contextSlot}, quote1 slot: ${quote1Resp?.contextSlot}`)
              logger.debug(`pairs: ${pair1.symbol} ${pair2.symbol}, quote is outdated, return...`)
              return;
          }
      }
      // 检查两个报价的contextSlot差距
      if (config.judgementConfig.ifJudgeSlotDiffOfQuotes) {
          let slotLimit = config.normalConfig.maxTolerantSlotDiffNum;
          let slotDiff = Math.abs(Number(quote0Resp?.contextSlot)-Number(quote1Resp?.contextSlot))
          if (slotDiff > slotLimit) {
              logger.debug(`pairs: ${pair1.symbol} ${pair2.symbol}, contextSlot difference ${slotDiff} exceed ${slotLimit}, return...`)
              return;
          }   
      }
      // 
      let buyPrice = Number(quote0Resp?.inAmount) / Number(quote0Resp?.outAmount);
      let sellPrice = Number(quote1Resp?.outAmount) / Number(quote1Resp?.inAmount);
      logger.debug(`${pair1.symbol}-${pair2.symbol} buyPrice: ${buyPrice}, sellPrice: ${sellPrice}`);
      logger.debug(`${pair1.symbol}-${pair2.symbol} quote0outAmount: ${quote0Resp?.outAmount}, quote1inAmount: ${quote1Resp?.inAmount}`);
      logger.debug(`${pair1.symbol}-${pair2.symbol} profitRatio: ${sellPrice/buyPrice-1}`);
      logger.debug(`${pair1.symbol}-${pair2.symbol} latestSlot: ${latestSlot}, quote0 slot: ${quote0Resp?.contextSlot}, quote1 slot: ${quote1Resp?.contextSlot}`);
      if (sellPrice/buyPrice-1 > minProfitBps) {
          // 通过检查，开始交易
          logger.info(`${pair1.symbol} -> ${pair2.symbol} -> ${pair1.symbol} price difference: ${sellPrice/buyPrice}`)
          logger.info(`${pair1.symbol}-${pair2.symbol} latestSlot: ${latestSlot}, quote0 slot: ${quote0Resp?.contextSlot}, quote1 slot: ${quote1Resp?.contextSlot}`);

          // 计算jito tip
          let jitoTip = Math.max(minJitoTip,Math.floor((sellPrice/buyPrice-1)*trade_main*jitoFeePercentage));
          logger.info(`${pair1.symbol}-${pair2.symbol} jitoTip: ${jitoTip}`);

          // swap参数
          let mergedQuoteResp = quote0Resp as QuoteResponse;
          mergedQuoteResp.outputMint = (quote1Resp as QuoteResponse).outputMint;
          mergedQuoteResp.outAmount = ifsendTxByJito ? (String(pair1_to_pair2.amount+jitoTip)) : (String(pair1_to_pair2.amount));
          mergedQuoteResp.otherAmountThreshold = ifsendTxByJito ? (String(pair1_to_pair2.amount+jitoTip)) : (String(pair1_to_pair2.amount));
          mergedQuoteResp.priceImpactPct = String(0);
          mergedQuoteResp.routePlan = mergedQuoteResp.routePlan.concat((quote1Resp as QuoteResponse).routePlan);
          let swapData : SwapRequest = {
              "userPublicKey": payer.publicKey.toBase58(),
              "wrapAndUnwrapSol": false,
              "useSharedAccounts": false,
              "skipUserAccountsRpcCalls": true,
              "quoteResponse": mergedQuoteResp,
          }

          // 构建交易
          try {
              let startGetSwapInstructionTime = Date.now();
              let instructions = await jupCon.swapInstructionsPost({ swapRequest: swapData })
              logger.info(`${pair1.symbol}-${pair2.symbol} get swap instructions cost: ${Date.now() - startGetSwapInstructionTime}ms`);

              let ixsRpc : TransactionInstruction[] = [];
              let ixsBundle: TransactionInstruction[] = [];
              let cu_ixs : TransactionInstruction[] = [];
              let cu_num = config.normalConfig.computeUnitBudget;
              let priorfee = selectPriorityFee(priorityFee as priorityFeeResponse,calculatePriorityLevel(sellPrice/buyPrice-1));

              // 1. setup instructions
              const setupInstructions = instructions.setupInstructions.map(instructionFormat);
              ixsRpc = ixsRpc.concat(setupInstructions);
              ixsBundle = ixsBundle.concat(setupInstructions);

              // 2. swap instructions
              const swapInstructions = instructionFormat(instructions.swapInstruction);
              ixsRpc.push(swapInstructions);
              ixsBundle.push(swapInstructions);

              // 3. 调用computeBudget设置cu
              const computeUnitLimitInstruction = ComputeBudgetProgram.setComputeUnitLimit({
                  units: cu_num,
              })
              cu_ixs.push(computeUnitLimitInstruction);

              // 4. 调用computeBudget设置优先费
              const computeUnitPriceInstruction = ComputeBudgetProgram.setComputeUnitPrice({
                  microLamports:priorfee,
              })
              cu_ixs.push(computeUnitPriceInstruction);
              // 合并cu_ixs
              ixsRpc = cu_ixs.concat(ixsRpc);
              ixsBundle = cu_ixs.concat(ixsBundle);

              if (ifsendTxByJito) {
                  // 5. 添加jito tip
                  const tipInstruction = SystemProgram.transfer({
                      fromPubkey: payer.publicKey,
                      toPubkey: new PublicKey(JitoTipAccounts[Math.floor(Math.random()*JitoTipAccounts.length)]),
                      lamports: jitoTip,
                  })
                  ixsBundle.push(tipInstruction);
              }

              const addressLookupTableAccounts = await Promise.all(
                  instructions.addressLookupTableAddresses.map(async (address) => {
                      let index = addressLookupTableList.findIndex((account) => account.key.toBase58() === new PublicKey(address).toBase58());
                      if (index !== -1) {
                          return addressLookupTableList[index];
                      } else {
                          const result = await con.getAddressLookupTable(new PublicKey(address));
                          addressLookupTableList.push(result.value as AddressLookupTableAccount);
                          ws.subscribeAccount(address);
                          return result.value as AddressLookupTableAccount;
                      }
                  })
              );

              // v0 tx
              let txsRpc : VersionedTransaction[] = [];
              let txsBundle : VersionedTransaction[] = [];
              blockhash_list.map((blockhash) => {
                  const messageV0 = new TransactionMessage({
                      payerKey: payer.publicKey,
                      recentBlockhash: blockhash,
                      instructions: ixsRpc,
                  }).compileToV0Message(addressLookupTableAccounts);
                  const transaction = new VersionedTransaction(messageV0);
                  transaction.sign([payer]);
                  txsRpc.push(transaction);
              });
              blockhash_list.map((blockhash) => {
                  const messageV0 = new TransactionMessage({
                      payerKey: payer.publicKey,
                      recentBlockhash: blockhash,
                      instructions: ixsBundle,
                  }).compileToV0Message(addressLookupTableAccounts);
                  const transaction = new VersionedTransaction(messageV0);
                  transaction.sign([payer]);
                  txsBundle.push(transaction);
              });

              // 提交交易
              try {
                  let promises : Promise<void>[] = [];
                  if (ifsendTxToBothRpcAndBundle) {
                      for (let i=0; i<txsBundle.length; i++) {
                          promises.push(sendTxToBundle(txsBundle[i],BundleApis[i%BundleApis.length],latestSlot,`${pair1.symbol}-${pair2.symbol}`));
                      }
                      for (let i=0; i<txsRpc.length; i++) {
                          promises.push(sendTxToRpc(txsRpc[i],sendTxCons[i%sendTxCons.length],latestSlot,`${pair1.symbol}-${pair2.symbol}`));
                      }
                      await Promise.all(promises);
                  } else {
                      if (ifsendTxByJito) {
                          for (let i=0; i<txsBundle.length; i++) {
                              promises.push(sendTxToBundle(txsBundle[i],BundleApis[i%BundleApis.length],latestSlot,`${pair1.symbol}-${pair2.symbol}`));
                          }
                          await Promise.all(promises);
                      } else {
                          for (let i=0; i<txsRpc.length; i++) {
                              promises.push(sendTxToRpc(txsRpc[i],sendTxCons[i%sendTxCons.length],latestSlot,`${pair1.symbol}-${pair2.symbol}`));
                          }
                          await Promise.all(promises);
                      }
                  }
              } catch (error) {
                  logger.error(`${pair1.symbol}-${pair2.symbol} submit tx error: ${error}`);
              }

          } catch (error) {
              logger.error(`${pair1.symbol}-${pair2.symbol} build tx error: ${error}`);
          }         
      }
  } catch (error) {
      logger.error(`monitor error: ${error}`);
  }
}


// 主函数
let wait = (ms:number) => new Promise((resolve) => setTimeout(resolve,ms));
let waitTime = config.normalConfig.waitTimePerRound;
let {pair1,pair2s} = JSON.parse(fs.readFileSync('./trade_pairs.json','utf-8'));

let num = 0;
async function main(num:number) {
  // 监测套利机会
  await monitor({
      pair1:pair1,
      pair2:pair2s[num],
      con:con,
      jupCon:jupCon
  })
  if (config.normalConfig.showWaitAndNextRound){console.log(`waiting for ${waitTime}ms...`)};
  await wait(waitTime);
  if (config.normalConfig.showWaitAndNextRound){console.log('start next round...')}
  main((num+1)%pair2s.length);
}

main(num).catch((error) => {
  logger.error(`main error: ${error}`);
});