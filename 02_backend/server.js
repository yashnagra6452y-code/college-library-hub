const express = require('express');
const { Pool } = require('pg');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Initialize PostgreSQL Connection Pool Configuration
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Create HTTP Server layer to inject Socket.io communication channels
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// ✅ RE-WRITTEN WITH BULLETPROOF FALLBACK VALUES TO PREVENT ENGINE CRASHES:
const JWT_SECRET = process.env.JWT_SECRET || 'SUPER_BEAST_MODE_SECRET_KEY_99X';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// =========================================================================
// 🛡️ SECURITY AUTHMIDDLEWARE LAYER
// =========================================================================
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: "Access Denied: Missing authorization token." });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: "Access Denied: Invalid or expired token session." });
        }
        req.user = user;
        next();
    });
}

// =========================================================================
// 🔐 SECURE AUTHENTICATION ENDPOINT
// =========================================================================
app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;

    if (!password) {
        return res.status(400).json({ error: "Password credential block input missing." });
    }

    if (password !== ADMIN_PASSWORD) {
        return res.status(401).json({ error: "Unauthorized: Invalid administrative credentials." });
    }

    // Generate an encrypted JWT token that expires automatically in 2 hours
    const accessToken = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '2h' });
    res.json({ success: true, token: accessToken });
});

// =========================================================================
// 🗄️ CORE BUSINESS API ROUTES (PUBLIC CHANNELS)
// =========================================================================

app.get('/api/seats', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM library_seats ORDER BY seat_number ASC');
        res.json(result.rows);
    } catch (error) {
        console.error("Error fetching seats:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

app.get('/api/books', async (req, res) => {
    const { search } = req.query;
    try {
        let queryText = 'SELECT * FROM library_books';
        let queryParams = [];

        if (search) {
            queryText += ' WHERE title ILIKE $1 OR author ILIKE $2 OR shelf_location ILIKE $3';
            const searchVal = `%${search}%`;
            queryParams = [searchVal, searchVal, searchVal];
        }

        queryText += ' ORDER BY id ASC';
        const result = await pool.query(queryText, queryParams);
        res.json(result.rows);
    } catch (error) {
        console.error("Error fetching books data matrix:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// =========================================================================
// 🔐 PROTECTED BUSINESS API ROUTES (REQUIRES SECURE VALID TOKEN SESSION)
// =========================================================================

app.post('/api/seats/toggle', authenticateToken, async (req, res) => {
    const { seat_number } = req.body;
    try {
        const currentSeat = await pool.query('SELECT is_occupied FROM library_seats WHERE seat_number = $1', [seat_number]);
        if (currentSeat.rows.length === 0) {
            return res.status(404).json({ error: "Seat map indicator out of range" });
        }

        const newStatus = !currentSeat.rows[0].is_occupied;
        await pool.query('UPDATE library_seats SET is_occupied = $1 WHERE seat_number = $2', [newStatus, seat_number]);

        io.emit('seatUpdated', { seat_number, is_occupied: newStatus });
        res.json({ message: `Seat ${seat_number} toggled successfully`, is_occupied: newStatus });
    } catch (error) {
        console.error("Error toggling seat:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

app.post('/api/books/issue', authenticateToken, async (req, res) => {
    const { book_id, student_id, student_name } = req.body;

    if (!book_id || !student_id || !student_name) {
        return res.status(400).json({ error: "Missing required checkout tracking credentials." });
    }

    try {
        const bookCheck = await pool.query('SELECT is_available FROM library_books WHERE id = $1', [book_id]);
        
        if (bookCheck.rows.length === 0) {
            return res.status(404).json({ error: "Book reference not tracked." });
        }
        if (!bookCheck.rows[0].is_available) {
            return res.status(400).json({ error: "Item currently locked in active transaction." });
        }

        const dueDate = new Date();
        dueDate.setDate(dueDate.getDate() + 14);

        await pool.query('UPDATE library_books SET is_available = FALSE WHERE id = $1', [book_id]);

        const newTransaction = await pool.query(
            `INSERT INTO library_transactions (book_id, student_id, student_name, due_date) 
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [book_id, student_id, student_name, dueDate]
        );

        io.emit('bookUpdated');

        res.status(200).json({ 
            message: "Transaction logged securely. Material distributed.", 
            transaction: newTransaction.rows[0] 
        });
    } catch (error) {
        console.error("Critical issue system block failure:", error);
        res.status(500).json({ error: "Internal tracking calculation error." });
    }
});

app.post('/api/books/return', authenticateToken, async (req, res) => {
    const { book_id } = req.body;

    if (!book_id) {
        return res.status(400).json({ error: "Missing required book ID parameter." });
    }

    try {
        const bookCheck = await pool.query('SELECT is_available FROM library_books WHERE id = $1', [book_id]);
        
        if (bookCheck.rows.length === 0) {
            return res.status(404).json({ error: "Book record not found." });
        }
        if (bookCheck.rows[0].is_available) {
            return res.status(400).json({ error: "This item is already back in stock." });
        }

        await pool.query('UPDATE library_books SET is_available = TRUE WHERE id = $1', [book_id]);

        await pool.query(
            `UPDATE library_transactions 
             SET return_date = CURRENT_TIMESTAMP 
             WHERE book_id = $1 AND return_date IS NULL`,
            [book_id]
        );

        io.emit('bookUpdated');

        res.status(200).json({ message: "Material checked in and ledger closed successfully." });
    } catch (error) {
        console.error("Critical return system failure:", error);
        res.status(500).json({ error: "Internal tracking calculation error." });
    }
});

// =========================================================================
// 🌐 REAL-TIME SOCKET HUB ROUTER CONNECTION
// =========================================================================
io.on('connection', (socket) => {
    console.log(`System Terminal Node Connected: ${socket.id}`);
    
    socket.on('disconnect', () => {
        console.log(`System Terminal Node Severed: ${socket.id}`);
    });
});

// Server Initialization
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`===================================================`);
    console.log(`🚀 BEAST CORE SERVER LIVE AND RUNNING ON PORT ${PORT}`);
    console.log(`===================================================`);
});