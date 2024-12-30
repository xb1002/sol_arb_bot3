import WebSocket from 'ws';
import { createLogger } from './logger.js';
import { wsConfig } from '../config.js';
import { DB } from './db.js';
import { normalConfig } from '../config.js';

// 创建logger
const logger = createLogger({ service: "wsTs" });

// 从wsConfig中获取配置
const { commitment, enableReceivedNotification, maxSubscriptionTime } = wsConfig;

// 创建数据库实例
const db = new DB();
if (normalConfig.deleteTableWhenStart){
    await db.deleteTable('wsTs');
}
await db.createTable({
    tableName: 'wsTs',
    fields: [
        'id INTEGER PRIMARY KEY AUTO_INCREMENT',
        'signature varchar(128)',
        'landSlot INT',
        'status varchar(32)',
    ]
})
// 获取当前数据库中的最新的id
let currentId = await db.customQuery('SELECT MAX(id) FROM wsTs').then((res) => {
    return (res as any)[0]['MAX(id)'] || 0;
})

const dropTagThreshold = 2;

// type
export type SubscribeMethods = 'signatureSubscribe' | 'accountSubscribe';
export type SubscribeNotificationMethods = 'signatureNotification' | 'accountNotification';
export type UnscribeMethods = 'signatureUnsubscribe' | 'accountUnsubscribe';
export type Status = "processing" | "done" | "timeout" | "error";
export type DropTag = number ; // 每处理一轮垃圾时标记一次不在processing的，默认为0，当为2时删除

// 参数 interface
// 取消订阅是通用的
export interface UnscribeParams {
    jsonrpc:"2.0", //jsonrpc版本
    id:number, // 会话id
    method:UnscribeMethods, // unscribe方法
    params:[number] // 订阅id
}
export interface GeneralSubscribeParams {
    jsonrpc:"2.0", //jsonrpc版本
    id:number, // 会话id
    method:SubscribeMethods, // 订阅方法
    params:any[] // 订阅参数
}
export interface SignatureSubscribeParams extends GeneralSubscribeParams {
    params:[
        string, {
        commitment?: string,
        enableReceivedNotification?: boolean
    }]
}
export interface AccountSubscribeParams extends GeneralSubscribeParams {
    params:[
        string, {
        encoding?: 'jsonParsed',
        commitment?: string,
    }]
}
function getUnscribeParams(id:number, method:UnscribeMethods, subscriptionId:number):UnscribeParams {
    return {
        jsonrpc:"2.0",
        id:id,
        method:method,
        params:[subscriptionId]
    }
}
function getSignatureSubscribeParams(id:number, method:SubscribeMethods,signature:string):SignatureSubscribeParams {
    return {
        jsonrpc:"2.0",
        id:id,
        method:method,
        params:[
            signature,
            {
                "commitment": commitment || "confirmed",
                "enableReceivedNotification": enableReceivedNotification || false,
            }
        ]
    }
}
function getAccountSubscribeParams(id:number, method:SubscribeMethods,address:string):AccountSubscribeParams {
    return {
        jsonrpc:"2.0",
        id:id,
        method:method,
        params:[
            address,
            {
                "encoding": "jsonParsed",
                "commitment": commitment || "confirmed",
            }
        ]
    }
}

// 结果 interface
export interface SignatureSubscribeResult {
    slot: number,
    err: any
}
export interface AccountSubscribeResult {
    slot: number,
}
    
export type SubscriptionDataItemResult = SignatureSubscribeResult | AccountSubscribeResult;

//
export const subscribeMethodToUnsubscribeMethod = {
    'signatureSubscribe': 'signatureUnsubscribe',
    'accountSubscribe': 'accountUnsubscribe',
}


export interface SubscriptionDataItem {
    id: number, // 递增id
    method: SubscribeMethods, // 订阅方法
    param: any, // 如果是signatureSubscribe，param为signature，如果是accountSubscribe，param为address
    status: Status, // 订阅状态
    startTime: number,//单位为ms
    maxSubscriptionTime: number,//单位为ms
    subscriptionId?: number,
    result?: SubscriptionDataItemResult
    dropTag: DropTag
}
export class WebSocketClient {
    private ws: WebSocket;
    private wsUrl: string;
    public subscriptionData: SubscriptionDataItem[] = [];
    private id: number = currentId + 1;

    constructor(wsUrl: string) {
        this.wsUrl = wsUrl;
        this.ws = new WebSocket(this.wsUrl);
        this.init();
        setInterval(() => {
            this.processInvalidSubscriptionData();
        }, 60000);
        setInterval(() => {
            if (this.ws.readyState === WebSocket.OPEN) {
                this.ws.ping();
            }
        }, 20000);
    }

    async wait(time: number) {
        return new Promise((resolve) => {
            setTimeout(() => {
                resolve(void 0);
            }, time);
        });
    }

    async init() {
        await this.waitForConnection();
        await this.setupWebSocketHandlers();
        await this.processInvalidSubscriptionData();
    }

    async waitForConnection() {
        while (this.ws.readyState !== WebSocket.OPEN) {
            await this.wait(1);
        }
        logger.debug('ws connected');
    }

    async setupWebSocketHandlers() {
        this.ws.on('open', () => {
            logger.debug('ws connected');
        });

        this.ws.on('message', (data) => {
            this.handleMessages(data as string);
        });

        this.ws.on('close', () => {
            logger.debug('ws closed');
            this.wait(5000).then(() => {
                logger.debug('ws try to reconnect');
                this.ws = new WebSocket(this.wsUrl);
                this.init();
                this.reSubscribe(); //恢复之前的订阅
            });
        });

        this.ws.on('error', (err) => {
            logger.error(`ws error: ${err}`);
            this.ws.close();
        });
    }

    handleMessages(data: string) {
        // logger.debug(`receive message: ${JSON.stringify(data, null, 2)}`);
        try {
            let res = JSON.parse(data);
            if (!res.method) {
                if (res.result === true || res.result === false) {
                    this.handleUnsubscribe(res); // 处理取消订阅
                } else {
                    this.handleSubscriptionId(res); // 配置订阅id
                }
            }
            if (res.method === 'signatureNotification') {
                this.handleSignatureNotification(res);
            }
            if (res.method === 'accountNotification') {
                this.handleAccountNotification(res);
            }
        } catch (err) {
            logger.error(`handleMessages error: ${err}`);
        }
    }

    handleSubscriptionId(data: any) {
        logger.debug(`subscriptionId: ${JSON.stringify(data, null, 2)}`);
        try {
            let index = this.subscriptionData.findIndex((item) => item.id === data.id);
            if (index !== -1) {
                this.subscriptionData[index].subscriptionId = data.result;
                logger.debug(`method:${this.subscriptionData[index].method} param:${this.subscriptionData[index].param} subscriptionId:${this.subscriptionData[index].subscriptionId}`);
            }
        } catch (err) {
            logger.error(`handleSubscriptionId error: ${err}`);
        }
    }

    handleUnsubscribe(data: any) {
        try {
            let id = data.id;
            let index = this.subscriptionData.findIndex((item) => item.id === id);
            if (index !== -1) {
                this.subscriptionData[index].status = data.result ? 'done' : 'error';
                logger.debug(`method:${this.subscriptionData[index].method} param:${this.subscriptionData[index].param} status:${this.subscriptionData[index].status}`);
            }
        } catch (err) {
            logger.error(`handleUnsubscribe error: ${err}`);
        }
    }

    handleSignatureNotification(data: any) {
        logger.debug(`signatureNotification: ${JSON.stringify(data, null, 2)}`);
        try {
            let slot = data.params.result.context.slot;
            let index = this.subscriptionData.findIndex((item) => item.subscriptionId === data.params.subscription);
            if (index !== -1) {
                this.subscriptionData[index].result = {
                    slot: slot,
                    err: data.params.result.value.err
                }
                this.subscriptionData[index].status = 'done';
                db.updateData({
                    tableName: 'wsTs',
                    fields: ['landSlot', 'status'],
                    values: [slot, 'done'],
                    where: [
                        { field: 'signature', operator: '=', value: this.subscriptionData[index].param }
                    ]
                });
                logger.debug(`method:${this.subscriptionData[index].method} param:${this.subscriptionData[index].param} slot:${slot} status:${this.subscriptionData[index].status}`);
            }
        } catch (err) {
            logger.error(`handleSignatureNotification error: ${err}`);
        }
    }

    handleAccountNotification(data: any) {
        logger.debug(`accountNotification: ${JSON.stringify(data, null, 2)}`);
        try {
            let slot = data.params.result.context.slot;
            let index = this.subscriptionData.findIndex((item) => item.subscriptionId === data.params.subscription);
            if (index !== -1) {
                this.subscriptionData[index].result = {
                    slot: slot,
                }
                logger.debug(`method:${this.subscriptionData[index].method} param:${this.subscriptionData[index].param} slot:${slot}`);
            }
        } catch (err) {
            logger.error(`handleAccountNotification error: ${err}`);
        }
    }

    async subscribeSignature(signature: string, commitment?: string, enableReceivedNotification?: boolean) {
        let index = this.subscriptionData.findIndex((item) => item.param === signature);
        let id;
        // 如果没有订阅过，就添加到subscriptionData，并返回id，否则返回已有的id
        if (index === -1) {
            id = this.id++; // 先返回id，再自增
            this.subscriptionData.push({
                id: id,
                startTime: new Date().getTime(),
                maxSubscriptionTime: maxSubscriptionTime || 60000,
                method: 'signatureSubscribe',
                param: signature,
                status: 'processing',
                dropTag: 0
            });
            await db.insertData({
                tableName: 'wsTs',
                fields: ['signature', 'status'],
                values: [signature, 'processing']
            });
        } else {
            id = this.subscriptionData[index].id;
        }
        let params = {
            "jsonrpc": "2.0",
            "id": id,
            "method": "signatureSubscribe",
            "params": [
                signature,
              {
                "commitment": commitment || "confirmed",
                "enableReceivedNotification": enableReceivedNotification || false,
              }
            ]
        }
        try {
            while (this.ws.readyState !== WebSocket.OPEN) {
                await this.wait(1)
            }
            this.ws.send(JSON.stringify(params));
            logger.debug(`subscribe signature: ${signature}`);
        } catch (err) {
            logger.error(`subscribeSignature error: ${err}`);
        }
    }

    async subscribeAccount(address: string, encoding?: 'jsonParsed', commitment?: string) {
        let index = this.subscriptionData.findIndex((item) => item.param === address);
        let id;
        // 如果没有订阅过，就添加到subscriptionData，并返回id，否则返回已有的id
        if (index === -1) {
            id = this.id++; // 先返回id，再自增
            this.subscriptionData.push({
                id: id,
                startTime: new Date().getTime(),
                maxSubscriptionTime: 1000 * 60 * 60 * 24,
                method: 'accountSubscribe',
                param: address,
                status: 'processing',
                dropTag: 0
            });
        } else {
            id = this.subscriptionData[index].id;
        }
        let params = {
            "jsonrpc": "2.0",
            "id": id,
            "method": "accountSubscribe",
            "params": [
                address,
                {
                    "encoding": encoding || "jsonParsed",
                    "commitment": commitment || "confirmed",
                }
            ]
        }
        try {
            while (this.ws.readyState !== WebSocket.OPEN) {
                await this.wait(1)
            }
            this.ws.send(JSON.stringify(params));
            logger.debug(`subscribe account: ${address}`);
        } catch (err) {
            logger.error(`subscribeAccount error: ${err}`);
        }
    }

    async unsubscribe(method: UnscribeMethods, param:string) {
        try {
            let index = this.subscriptionData.findIndex((item) => item.param === param);
            let id = this.subscriptionData[index].id;
            if (index !== -1) {
                let params = {
                    "jsonrpc": "2.0",
                    "id": id,
                    "method": method,
                    "params": [this.subscriptionData[index].subscriptionId]
                }
                while (this.ws.readyState !== WebSocket.OPEN) {
                    await this.wait(1)
                }
                this.ws.send(JSON.stringify(params));
            }
        } catch (err) {
            logger.error(`unsubscribe error: ${err}`);
        }
    }

    dropInvalidSubscriptionData() {
        this.subscriptionData.map((item) => {
            if (item.status !== 'processing') {
                item.dropTag = item.dropTag + 1;
            }
        });
        this.subscriptionData = this.subscriptionData.filter((item) => item.dropTag < dropTagThreshold);
    }

    processInvalidSubscriptionData() {
        let now = new Date().getTime();
        // 将超时的订阅状态改为timeout
        this.subscriptionData.map((item) => {
            if (now - item.startTime > item.maxSubscriptionTime && item.status === 'processing') {
                item.status = 'timeout';
                db.updateData({
                    tableName: 'wsTs',
                    fields: ['status'],
                    values: ['timeout'],
                    where: [
                        { field: 'signature', operator: '=', value: item.param }
                    ]
                });
            }
        });
        this.dropInvalidSubscriptionData();
    }

    reSubscribe() {
        this.subscriptionData.map((item) => {
            if (item.status === 'processing') {
                if (item.method === 'signatureSubscribe') {
                    this.subscribeSignature(item.param);
                }
                if (item.method === 'accountSubscribe') {
                    this.subscribeAccount(item.param);
                }
            }
        });
    }
}