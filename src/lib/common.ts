import axios from "axios";
import { PublicKey,Connection,VersionedTransaction
 } from "@solana/web3.js";
import { Instruction } from "@jup-ag/api";
import {priorityFeeConfig,priorityFeeLevelThreshold,TradePair} from "../config.js";
import bs58 from "bs58";
import { createLogger } from "./logger.js";


export async function wait(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 计算手续费优先级
export function calculatePriorityLevel(profitPercentage: number) {
    if (profitPercentage >= priorityFeeLevelThreshold.extreme) {
        return "extreme";
    } else if (profitPercentage >= priorityFeeLevelThreshold.high) {
        return "high";
    } else if (profitPercentage >= priorityFeeLevelThreshold.medium) {
        return "medium";
    } else {
        return "low";
    }
}

// 选择手续费等级
export function selectPriorityFee(fee: priorityFeeResponse, level: string) {
    switch (level) {
        case "extreme":
            return Math.min(fee.FeeOfExtreme, priorityFeeConfig.maxFeeOfExtreme);
        case "high":
            return Math.min(fee.FeeOfHigh, priorityFeeConfig.maxFeeOfHigh);
        case "medium":
            return Math.min(fee.FeeOfMedium, priorityFeeConfig.maxFeeOfMedium);
        case "low":
            return Math.min(fee.FeeOfLow, priorityFeeConfig.maxFeeOfLow);
        default:
            return Math.min(fee.FeeOfMedium, priorityFeeConfig.maxFeeOfMedium);
    }
}

// format Instruction
export function instructionFormat(instruction : Instruction) {
    return {
        programId: new PublicKey(instruction.programId),
        keys: instruction.accounts.map((account) => ({
            pubkey: new PublicKey(account.pubkey),
            isSigner: account.isSigner,
            isWritable: account.isWritable
        })),
        data: Buffer.from(instruction.data, 'base64')
    };
}

// 获取账户余额
export async function getMainBalance(ATA:PublicKey,Con:Connection) : Promise<number> {
    try {
        const result = await Con.getTokenAccountBalance(ATA);
        return (Number(result.value.amount));
    } catch (error) {
        throw new Error(error as string);
    }
}

// 获取优先级费用
export interface priorityFeeResponse {
    FeeOfExtreme: number;
    FeeOfHigh: number;
    FeeOfMedium: number;
    FeeOfLow: number;
}
export async function getPriorityFee(RPC: string, account?: string) : Promise<priorityFeeResponse|undefined> {
    const myHeaders = new Headers();
    myHeaders.append("Content-Type", "application/json");
    const raw = JSON.stringify({
    "jsonrpc": "2.0",
    "id": 1,
    "method": "qn_estimatePriorityFees",
    "params": {
        "last_n_blocks": 100,
        "account": account || "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
        "api_version": 2
    }
    });
    const requestOptions = {
    method: "POST",
    headers: myHeaders,
    body: raw,
    // redirect: "follow"
    };
    var feeReslut;
    await fetch(RPC, requestOptions).then((response) => response.text())
    .then((result) => {
        let res = JSON.parse(result).result;
        feeReslut =  {
            FeeOfExtreme: res.per_compute_unit.extreme,
            FeeOfHigh: res.per_compute_unit.high,
            FeeOfMedium: res.per_compute_unit.medium,
            FeeOfLow: res.per_compute_unit.low
        };
    })
    .catch((error) => {
        throw new Error(error);
    });
    return feeReslut || undefined;
}

// 从gmgnai获取交易对
interface getPairsParams {
    timeSpan: string;
    startNum: number;
    pairNum: number;
}
export async function getPairs(params:getPairsParams) : Promise<TradePair[]> {
    const {timeSpan,startNum,pairNum} = params;
    try {
        const url = `http://47.237.120.213:9488/defi/quotation/v1/rank/sol/swaps/${timeSpan}?orderby=volume&direction=desc&filters[]=renounced&filters[]=frozen&filters[]=burn&filters[]=distribed`
        let resp = await axios.get(url);
        if (resp.data.code != 0) {
            throw new Error(`getPairs error, code: ${resp.data.code}, msg: ${resp.data.msg}`)
        } else {
            let result = resp.data.data.rank.slice(startNum,startNum+pairNum).map((pair:any) => {
                return {
                    symbol: pair.symbol,
                    mint: pair.address
                }
            })
            return result as TradePair[];
        }
    } catch (err) {
        throw new Error(`getPairs error: ${err}`)
    }
}