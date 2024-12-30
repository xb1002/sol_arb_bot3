import mysql from 'mysql2/promise';
import { dbConfig } from '../config.js';
import { createLogger } from './logger.js';

// 配置logger
const logger = createLogger({ service: 'db' });

// interface
// DB params interface
interface DBParams {
    host: string,
    user: string,
    password: string,
    database: string,
    port: number,
}
// DB create table params interface
interface CreateTableParams {
    tableName: string,
    fields: string[],
}
// where clause interface
interface WhereClause {
    field: string;
    operator: string;
    value: any;
}
// DB insert data by field names and values params interface
interface InsertDataParams {
    tableName: string,
    fields: string[],
    values: any[],
}
// 修改数据
interface UpdateDataParams {
    tableName: string;
    fields: string[];
    values: any[];
    where: WhereClause[];
}
// 删除数据
interface DeleteDataParams {
    tableName: string,
    where: string,
}

// 从dbConfig中获取数据库连接信息
const { host, user, password, database, port } = dbConfig;

class DB {
    private pool: mysql.Pool;

    constructor(params?: DBParams) {
        try {
            this.pool = mysql.createPool({
            host: params?.host || host,
            user: params?.user || user,
            password: params?.password || password,
            database: params?.database || database,
            port: params?.port || port,
            });
        } catch (error) {
            throw new Error(`failed to connect database: ${error}`);
        }
    }

    // 删除表
    deleteTable = async (tableName: string) => {
        try {
            const connection = await this.pool.getConnection();
            const sql = `DROP TABLE IF EXISTS ${tableName}`;
            await connection.query(sql);
            connection.release();
        } catch (error) {
            logger.error(`failed to delete table: ${error}`);
        }
    }

    // 创建表
    createTable = async (params: CreateTableParams) => {
        try {
            const connection = await this.pool.getConnection();
            const { tableName, fields } = params;
            const sql = `CREATE TABLE IF NOT EXISTS ${tableName} (${fields.join(',')})`;
            await connection.query(sql);
            connection.release();
        } catch (error) {
            logger.error(`failed to create table: ${error}`);
        }
    }

    // 插入数据
    insertData = async (params: InsertDataParams) => {
        try {
            const connection = await this.pool.getConnection();
            const { tableName, fields, values } = params;
            const sql = `INSERT INTO ${tableName} (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`;
            await connection.query(sql, values);
            connection.release();
        } catch (error) {
            logger.error(`failed to insert data: ${error}`);
        }
    }

    // 修改数据
    updateData = async (params: UpdateDataParams) => {
        try {
            const connection = await this.pool.getConnection();
            const { tableName, fields, values, where } = params;

            // 构建 SET 子句
            const setClause = fields.map((field) => `${field} = ?`).join(',');

            // 构建 WHERE 子句
            const whereClause = where.map((clause) => `${clause.field} ${clause.operator} ?`).join(' AND ');
            const whereValues = where.map((clause) => clause.value);

            // 合并所有值
            const allValues = [...values, ...whereValues];

            const sql = `UPDATE ${tableName} SET ${setClause} WHERE ${whereClause}`;
            await connection.query(sql, allValues);
            connection.release();
        } catch (error) {
            logger.error(`failed to update data: ${error}`);
        }
    }
    
    // 自定义查询
    customQuery = async (sql: string, values?: any) => {
        try {
            const connection = await this.pool.getConnection();
            if (!values) {
                const [rows] = await connection.query(sql);
                connection.release();
                return rows;
            } else {
                const [rows] = await connection.query(sql, values);
                connection.release();
                return rows;
            }
        } catch (error) {
            logger.error(`failed to custom query: ${error}`);
            return null;
        }
    }
}



// 导出DB类
export { DB, CreateTableParams, InsertDataParams, UpdateDataParams, DeleteDataParams, WhereClause };