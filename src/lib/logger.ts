import winston from "winston";
import { LOG_LEVEL } from "../config.js";

// 自定义格式化器
const customFormat = winston.format.printf(({ level, message, service, timestamp }) => {
    return `${timestamp} [${service}] ${level}: ${message}`;
});

interface createLoggerParams {
    level?: string,
    service?: string
}
export function createLogger(params:createLoggerParams): winston.Logger {
    /*
    * 创建一个logger
    * @param level 日志级别
    * @param service 服务名称
    * @return logger
    */
    // 从参数中获取日志级别和服务名称 
    const { level, service } = params;
    // 创建logger
    const logger = winston.createLogger({
        level: level || LOG_LEVEL,
        format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.json(),
            customFormat
        ),
        defaultMeta: { service: service || "general" },
        transports: [
            new winston.transports.Console(),
            new winston.transports.File({ filename: "logs/info.log" , level: "info"}),
            new winston.transports.File({ filename: "logs/error.log", level: "error" }),
        ],
    })
    return logger;
}