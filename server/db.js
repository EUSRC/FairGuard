// server/db.js
const mysql = require('mysql2');
const config = require('./config');

// 使用连接池以提高性能和稳定性
const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: config.db.connectionLimit,
  queueLimit: 0
});

// 导出 promise 化的连接池
module.exports = pool.promise();