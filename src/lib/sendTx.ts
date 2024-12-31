import axios from "axios";
import { PublicKey,Connection,VersionedTransaction
 } from "@solana/web3.js";
import bs58 from "bs58";
import { createLogger } from "./logger.js";
import { DB } from "./db.js";
import { WebSocketClient } from "./ws.js";
import { normalConfig } from "../config.js";
import "dotenv/config";

// 日志
const logger = createLogger({service: "sendTx"});

// 读取环境变量
const rpcRetryInterval = parseInt(process.env.RPC_RETRY_INTERVAL || "200");
const rpcRetries = parseInt(process.env.RPC_RETRIES || "1");
const bundleRetryInterval = parseInt(process.env.BUNDLE_RETRY_INTERVAL || "200");
const bundleRetries = parseInt(process.env.BUNDLE_RETRIES || "1");

// 数据库配置
// 数据库配置
const db = new DB();
if (normalConfig.deleteTableWhenStart) {
    await db.deleteTable('sendTxTs');
}
await db.createTable({
    tableName: "sendTxTs",
    fields: [
      'id INT AUTO_INCREMENT PRIMARY KEY',
      'signature varchar(128) not null',
      'startSlot INT not null',
      'rpc varchar(255)',
      'quote0Slot INT',
      'quote1Slot INT'
    ]
  });

// 发送交易到rpc
type quoteSlot = number|undefined|null
export async function sendTxToRpc(tx:VersionedTransaction,connection:Connection,ws:WebSocketClient,slot:number,quote0Slot:quoteSlot,quote1Slot:quoteSlot,name:string) {
    try {
        let start = new Date().getTime();
        await connection.sendRawTransaction(tx.serialize(), {
            skipPreflight: true,
            maxRetries: 0
        }).then(async (resp) => {
            logger.info(`${name} sendTxToRpc: ${resp}`)
            logger.info(`${name} sendTxToRpc time cost: ${new Date().getTime() - start}ms`)
            if (quote0Slot === undefined) quote0Slot = null
            if (quote1Slot === undefined) quote1Slot = null
            await db.insertData({
                tableName: "sendTxTs",
                fields: ['signature', 'startSlot', 'rpc', 'quote0Slot', 'quote1Slot'],
                values: [resp, slot, connection.rpcEndpoint, quote0Slot, quote1Slot]
            })
            ws.subscribeSignature(resp)
        })
        for (let i = 0; i < rpcRetries; i++) {
            await new Promise((resolve) => setTimeout(resolve, rpcRetryInterval))
            await connection.sendRawTransaction(tx.serialize(), {
                skipPreflight: true,
                maxRetries: 0
            }).then(async (resp) => {
                logger.info(`retry ${i+1} ${name} sendTxToRpc: ${resp} success`)
            }).catch(async (err) => {
                logger.error(`retry ${i+1} ${name} sendTxToRpc error: ${err}`)
            })
        }
    } catch (err) {
        logger.error(`${name} sendTxToRpc error: ${err}`)
    }
}

// 发送交易到bundle
export async function sendTxToBundle(tx:VersionedTransaction,bundle_api:string,slot:number,name:string) {
    try {
        let start = new Date().getTime();
        const serializedTransaction = tx.serialize();
        const base58Transaction = bs58.encode(serializedTransaction);
        const bundle = {
            jsonrpc: "2.0",
            id: 1,
            method: "sendBundle",
            params: [[base58Transaction]]
        };
        axios.post(new URL("api/v1/bundles",bundle_api).href, bundle, {
            headers: {
                'Content-Type': 'application/json'
            }
        }).then((resp) => {
            logger.info(`${name} sendTxToBundle: ${resp.data.result}`)
            logger.info(`${name} sendTxToBundle time cost: ${new Date().getTime() - start}ms`)
        })
        for (let i = 0; i < bundleRetries; i++) {
            await new Promise((resolve) => setTimeout(resolve, bundleRetryInterval))
            axios.post(new URL("api/v1/bundles",bundle_api).href, bundle, {
                headers: {
                    'Content-Type': 'application/json'
                }
            }).then((resp) => {
                logger.info(`retry ${i+1} ${name} sendTxToBundle: ${resp.data.result} success`)
            }).catch((err) => {
                logger.error(`retry ${i+1} ${name} sendTxToBundle error: ${err}`)
            })
        }
    } catch (err) {
        logger.error(`${name} sendTxToBundle error: ${err}`)
    }
}