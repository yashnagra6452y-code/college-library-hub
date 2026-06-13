const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const http = require('http'); // Import built-in Node HTTP module
const { Server } = require('socket.io'); // Import Socket.io
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Create an HTTP server wrapping our Express app instance
const server = http.createServer(app);

// Initialize Socket.io and configure it to accept frontend traffic
const io = new Server(server, {
    cors: {
        origin: "*", // Allows your local HTML files to connect securely
        methods: ["GET", "POST"]
    }
});

// Setup the Neon PostgreSQL Database Connection Pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Real-Time WebSocket Connection Event Engine
io.on('connection', (socket) => {
    console.log(`User connected to live updates: ${socket.id}`);

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
    });
});

// API Endpoint 1: Fetch all seats for students and admin panel
app.get('/api/seats', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM library_seats ORDER BY seat_number ASC');
        res.json(result.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// API Endpoint 2: Search for books in the library catalog
app.get('/api/books', async (req, res) => {
    try {
        const searchWord = req.query.search || '';
        const result = await pool.query(
            'SELECT * FROM library_books WHERE title ILIKE $1 OR author ILIKE $1',
            [`%${searchWord}%`]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// 🔒 SECURE ADMIN ENDPOINT: Update seat status with master PIN protection
app.post('/api/seats/toggle', async (req, res) => {
    const { seat_number, is_occupied } = req.body;
    const clientPin = req.headers['x-admin-pin']; // Extract the PIN sent by the frontend header

    // SECURITY AUTHENTICATION: Check if the client PIN matches the master PIN in our hidden .env file
    if (!clientPin || clientPin !== process.env.ADMIN_PIN) {
        console.log(`⚠️ Blocked unauthorized attempt to change Seat ${seat_number}`);
        return res.status(401).json({ success: false, message: "Unauthorized: Invalid Admin PIN." });
    }

    try {
        // Execute database update query
        await pool.query(
            'UPDATE library_seats SET is_occupied = $1 WHERE seat_number = $2',
            [is_occupied, seat_number]
        );

        // 🚀 THE WEBSOCKET BROADCAST: Broadcast the update out to ALL open student screens instantly
        io.emit('seatUpdated', { seat_number, is_occupied });

        res.json({ success: true, message: `Seat ${seat_number} status updated successfully.` });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

const PORT = process.env.PORT || 5000;
// We listen on the HTTP wrapper server so that traditional API routes AND WebSockets work together seamlessly
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));