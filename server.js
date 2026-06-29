const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const iot = require('alibabacloud-iot-device-sdk');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// ================= 1. 连接本地 MySQL 数据库 =================
const db = mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '123456', 
    database: process.env.DB_NAME || 'sleep_monitor'
});

db.connect((err) => {
    if (err) {
        console.error('❌ 数据库连接失败:', err.message);
        return;
    }
    console.log('🎉 MySQL 数据库连接成功！');
});

// ================= 2. 连接阿里云 (扮演接收端) =================
const productKey = process.env.IOT_PRODUCT_KEY;
const deviceName = process.env.IOT_DEVICE_NAME; 

const client = iot.device({
    productKey: productKey,
    deviceName: deviceName,
    deviceSecret: process.env.IOT_DEVICE_SECRET, 
    regionId: process.env.IOT_REGION_ID || 'cn-shanghai'
});

client.on('connect', () => {
    console.log('☁️ 成功连接到阿里云 IoT！正在监听单片机数据...');
    client.subscribe(`/${productKey}/${deviceName}/user/get`);
});

// ================= 3. 核心：收到数据 -> 存入数据库 =================
client.on('message', (topic, message) => {
    const payload = JSON.parse(message.toString());

    let hr = 0, temp = 0.0, resp = 0, movement = 0, presence = 0, sleepTime = 0, runTime = 0;

    if (payload.items) {
        if (payload.items.HeartRate) hr = payload.items.HeartRate.value;       
        if (payload.items.Temperature) temp = payload.items.Temperature.value; 
        if (payload.items.BreathRate) resp = payload.items.BreathRate.value;   
        if (payload.items.MotionValue) movement = payload.items.MotionValue.value; 
        if (payload.items.Presence) presence = payload.items.Presence.value;   
        if (payload.items.SleepTime) sleepTime = payload.items.SleepTime.value;
        if (payload.items.Uptime) runTime = payload.items.Uptime.value;        
    }

    if (temp === 0 && resp === 0 && movement === 0) {
        return; 
    }

    if (hr > 0) {
        const sql = `
            INSERT INTO health_data 
            (device_name, heart_rate, temperature, respiratory_rate, body_movement, presence_state, sleep_duration, system_run_time) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `;
        const values = ['Device_01', hr, temp, resp, movement, presence, sleepTime, runTime];

        db.query(sql, values, (err, result) => {
            if (err) {
                console.error('❌ 数据写入失败:', err.message);
            } else {
                console.log(`✅ 入库成功! [心率:${hr}|体温:${temp}|呼吸:${resp}|体动:${movement}]`);
            }
        });
    }
});

// ================= 🌟 4. 新增接口一：给小程序首页提供最新单条实时数据 =================
app.get('/api/health/latest', (req, res) => {
    const sql = `
        SELECT heart_rate, temperature, respiratory_rate, body_movement, 
               presence_state, sleep_duration, system_run_time,
               DATE_FORMAT(record_time, "%H:%i:%s") as time 
        FROM health_data 
        ORDER BY id DESC LIMIT 1
    `;
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ code: 500, message: '数据库查询失败' });
        res.json({ code: 200, message: '获取成功', data: results[0] || {} });
    });
});

// ================= 🌟 5. 新增接口二：给小程序四大图表和算法打分提供历史数据 =================
app.get('/api/health/data', (req, res) => {
    const sql = `
        SELECT heart_rate, temperature, respiratory_rate, body_movement,
               sleep_duration, system_run_time,
               DATE_FORMAT(record_time, "%H:%i") as time 
        FROM health_data 
        ORDER BY id DESC LIMIT 30
    `;
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ code: 500, message: '数据库查询失败' });
        // 反转数组，让最旧的数据在左边，最新的在右边，画图才对
        res.json({ code: 200, message: '获取图表数据成功', data: results.reverse() });
    });
});

// ================= 🌟 6. 升级接口三：智谱 AIGC 加强版 (加入了呼吸和体动) =================
app.get('/api/health/analyze', async (req, res) => {
    const sql = 'SELECT heart_rate, temperature, respiratory_rate, body_movement FROM health_data ORDER BY id DESC LIMIT 50';
    db.query(sql, async (err, results) => {
        if (err) return res.status(500).json({ code: 500, message: '查询失败' });
        
        let avgHr = 0, avgTemp = 0, avgResp = 0, sumMove = 0;
        if (results.length > 0) {
            avgHr = results.reduce((sum, item) => sum + item.heart_rate, 0) / results.length;
            avgTemp = results.reduce((sum, item) => sum + item.temperature, 0) / results.length;
            // 新增计算：平均呼吸频率 和 睡眠周期体动总和
            avgResp = results.reduce((sum, item) => sum + item.respiratory_rate, 0) / results.length;
            sumMove = results.reduce((sum, item) => sum + item.body_movement, 0);
        }

        // 把呼吸和体动参数全都加紧提示词里，让 AI 诊断更加专业
        const promptText = `你是一个专业的睡眠健康专家。请根据以下夜间体征数据给出简短贴心的睡眠建议（150字以内）：\n持续监测约${results.length * 5}秒，平均心率${avgHr.toFixed(1)}bpm，平均体温${avgTemp.toFixed(1)}℃，平均呼吸频率${avgResp.toFixed(1)}次/分，整晚体动总计${sumMove}次。\n若数据异常（如心率偏高、体动过于频繁、呼吸频率不在12-20次/分正常范围），请指出可能存在的睡眠浅或呼吸问题。`;

        try {
            const aiResponse = await fetch(process.env.AI_API_URL || 'https://linkapi.ai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.AI_API_KEY}` 
                },
                body: JSON.stringify({
                    model: process.env.AI_MODEL || 'gemini-3-flash-preview',
                    messages: [
                        { role: 'system', content: '你是一名专业、语气温和的睡眠医学专家。你的任务是分析用户的睡眠体征并给出科学贴心的建议。' },
                        { role: 'user', content: promptText }
                    ]
                })
            });
            const aiData = await aiResponse.json();
            const advice = aiData.choices[0].message.content;
            res.json({ code: 200, message: 'AI 分析成功', advice: advice });
        } catch (error) {
            console.error('❌ AI 接口调用失败:', error);
            res.status(500).json({ code: 500, message: 'AI 分析服务不可用' });
        }
    });
});

// ================= 7. 启动后端服务器 =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 后端服务器已启动，监听端口: http://localhost:${PORT}`);
});
