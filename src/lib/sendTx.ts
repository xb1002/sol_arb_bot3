import axios from "axios";
import { PublicKey,Connection,VersionedTransaction
 } from "@solana/web3.js";
import bs58 from "bs58";
import { createLogger } from "./logger.js";
import { DB } from "./db.js";

// 日志
const logger = createLogger({service: "sendTx"});

// 数据库配置
// 数据库配置
const db = new DB();
await db.deleteTable('sendTxTs');
await db.createTable({
    tableName: "sendTxTs",
    fields: [
      'id INT AUTO_INCREMENT PRIMARY KEY',
      'signature varchar(128) not null',
      'startSlot INT not null',
      'rpc varchar(64)',
    ]
  });

// 发送交易到rpc
export async function sendTxToRpc(tx:VersionedTransaction,connection:Connection,slot:number,name:string) {
    try {
        let start = new Date().getTime();
        await connection.sendRawTransaction(tx.serialize(), {
            skipPreflight: true,
            maxRetries: 0
        }).then((resp) => {
            logger.info(`${name} sendTxToRpc: ${resp}`)
            logger.info(`${name} sendTxToRpc time cost: ${new Date().getTime() - start}ms`)
            db.insertData({
                tableName: "sendTxTs",
                fields: ['signature', 'startSlot', 'rpc'],
                values: [resp, slot, connection.rpcEndpoint]
            })
        })
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
            db.insertData({
                tableName: "sendTxTs",
                fields: ['signature', 'startSlot', 'rpc'],
                values: [resp.data.result, slot, bundle_api]
            })
        })
    } catch (err) {
        logger.error(`${name} sendTxToBundle error: ${err}`)
    }
}