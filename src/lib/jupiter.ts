import {getPairs} from './common.js'
import { TradePair,trade_pairs } from '../config.js'
import fs from 'fs'

// 获取交易对
const {timeSpan,startNum,pairNum} = trade_pairs
let pairs = await getPairs({timeSpan,startNum,pairNum})

let data = {
    pair1:trade_pairs.pair1,
    pair2s:pairs
}
// 把pairs写入文件trade_pairs.json
fs.writeFileSync('./trade_pairs.json',JSON.stringify(data,null,2))

let cmdCommand = `RUST_LOG=info /root/jupiter/jupiter-swap-api --rpc-url https://solana-rpc.publicnode.com --allow-circular-arbitrage --market-mode remote --filter-markets-with-mints ${trade_pairs.pair1.mint},` + pairs.map((pair:TradePair)=>pair.mint).join(',')

console.log(cmdCommand)
