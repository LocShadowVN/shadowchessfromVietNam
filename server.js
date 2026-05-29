const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname))); 

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const JWT_SECRET = "shadow_secret_999";

// KẾT NỐI DATABASE (Tạm thời dùng RAM nếu chưa có MongoDB Atlas)
mongoose.connect("mongodb://localhost:27017/shadowchess").catch(() => {
    console.log("⚠️ Cảnh báo: Đang chạy DB tạm trên RAM. Dữ liệu sẽ mất khi tắt CMD.");
});

// THIẾT KẾ DATABASE CHO SHADOWCHESS
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    // 3 Loại Elo riêng biệt
    elo_bullet: { type: Number, default: 800 },
    elo_blitz: { type: Number, default: 1200 },
    elo_rapid: { type: Number, default: 1500 },
    offenses: { type: Number, default: 0 },
    banUntil: { type: Date, default: null }
});
const User = mongoose.model('User', userSchema);

// --- API HỆ THỐNG ---

// Đăng ký
app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ username, password: hashedPassword });
        await newUser.save();
        res.status(201).json({ message: "Đăng ký thành công!" });
    } catch (e) { res.status(400).json({ error: "Tên tài khoản đã tồn tại!" }); }
});

// Đăng nhập
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user) return res.status(404).json({ error: "Sai tài khoản!" });
    if (user.banUntil && user.banUntil > Date.now()) {
        return res.status(403).json({ error: `Tài khoản bị khóa đến: ${user.banUntil.toLocaleString()}` });
    }
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: "Sai mật khẩu!" });
    const token = jwt.sign({ username: user.username }, JWT_SECRET);
    res.json({ token, user: { username: user.username, elo_bullet: user.elo_bullet, elo_blitz: user.elo_blitz, elo_rapid: user.elo_rapid } });
});

// Bảng xếp hạng
app.get('/api/leaderboard/:type', async (req, res) => {
    const type = `elo_${req.params.type}`;
    const topPlayers = await User.find({}).sort({ [type]: -1 }).limit(10).select(`username ${type}`);
    res.json(topPlayers);
});

// Tố cáo (3 Strikes)
app.post('/api/report', async (req, res) => {
    const { reportedUser } = req.body;
    const user = await User.findOne({ username: reportedUser });
    if (!user) return res.status(404).json({ error: "Không tìm thấy user" });
    user.offenses += 1;
    let msg = "";
    if (user.offenses === 1) msg = "Cảnh cáo lần 1!";
    else if (user.offenses === 2) { msg = "Khóa 7 ngày!"; user.banUntil = new Date(Date.now() + 7*24*60*60*1000); }
    else { msg = "Khóa vĩnh viễn!"; user.banUntil = new Date("2099-12-31"); }
    await user.save();
    io.emit('kickUser', { username: reportedUser, reason: msg });
    res.json({ message: "Đã xử lý!" });
});

// --- LOGIC GAME THỜI GIAN THỰC ---
let queues = { bullet: [], blitz: [], rapid: [] };
let activeRooms = {};

io.on('connection', (socket) => {
    socket.on('findMatch', (data) => {
        let player = { id: socket.id, username: data.username, elo: data.elo, type: data.type };
        queues[data.type].push(player);

        if (queues[data.type].length >= 2) {
            let p1 = queues[data.type].shift();
            let p2 = queues[data.type].shift();
            let roomId = 'room_' + Date.now();
            activeRooms[roomId] = { p1, p2, turn: 'w', fen: 'start', time: 600, lastMove: Date.now() };
            io.to(p1.id).emit('matchFound', { roomId, color: 'w', opponent: p2, type: data.type });
            io.to(p2.id).emit('matchFound', { roomId, color: 'b', opponent: p1, type: data.type });
        }
    });

    socket.on('makeMove', (data) => {
        let room = activeRooms[data.roomId];
        if (room) {
            socket.to(data.roomId).emit('opponentMove', { move: data.move, fen: data.fen });
        }
    });

    socket.on('joinRoom', (id) => socket.join(id));
});

server.listen(process.env.PORT || 3000, () => console.log('Shadowchess is Live!'));