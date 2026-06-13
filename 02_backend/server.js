const express = require('express');
const { Pool } = require('pg');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
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

// =========================================================================
// 🗄️ CORE BUSINESS API ROUTES
// =========================================================================

// 1. Fetch all seats
app.get('/api/seats', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM library_seats ORDER BY seat_number ASC');
        res.json(result.rows);
    } catch (error) {
        console.error("Error fetching seats:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// 2. Toggle seat status (Real-Time update)
app.post('/api/seats/toggle', async (req, res) => {
    const { seat_number } = req.body;
    try {
        const currentSeat = await pool.query('SELECT is_occupied FROM library_seats WHERE seat_number = $1', [seat_number]);
        if (currentSeat.rows.length === 0) {
            return res.status(404).json({ error: "Seat map indicator out of range" });
        }

        const newStatus = !currentSeat.rows[0].is_occupied;
        await pool.query('UPDATE library_seats SET is_occupied = $1 WHERE seat_number = $2', [newStatus, seat_number]);

        // 📢 Broadcast change to all connected clients immediately
        io.emit('seatUpdated', { seat_number, is_occupied: newStatus });
        res.json({ message: `Seat ${seat_number} toggled successfully`, is_occupied: newStatus });
    } catch (error) {
        console.error("Error toggling seat:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// 3. Fetch books or execute conditional query search parameters
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

// 🚀 BEAST MODE FEATURE: Issue a book to a specific student
app.post('/api/books/issue', async (req, res) => {
    const { book_id, student_id, student_name } = req.body;

    if (!book_id || !student_id || !student_name) {
        return res.status(400).json({ error: "Missing required checkout tracking credentials." });
    }

    try {
        // A. Verify item validation logs
        const bookCheck = await pool.query('SELECT is_available FROM library_books WHERE id = $1', [book_id]);
        
        if (bookCheck.rows.length === 0) {
            return res.status(404).json({ error: "Book reference not tracked." });
        }
        if (!bookCheck.rows[0].is_available) {
            return res.status(400).json({ error: "Item currently locked in active transaction." });
        }

        // B. Formulate a 14-day tracking window deadline timestamp
        const dueDate = new Date();
        dueDate.setDate(dueDate.getDate() + 14);

        // C. Update availability flag metrics
        await pool.query('UPDATE library_books SET is_available = FALSE WHERE id = $1', [book_id]);

        // D. Commit transactional log entry rows
        const newTransaction = await pool.query(
            `INSERT INTO library_transactions (book_id, student_id, student_name, due_date) 
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [book_id, student_id, student_name, dueDate]
        );

        // 📢 Inform the system layout about the catalog metrics change
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

// 🚀 BEAST MODE FEATURE: Log a returned book back into stock
app.post('/api/books/return', async (req, res) => {
    const { book_id } = req.body;

    if (!book_id) {
        return res.status(400).json({ error: "Missing required book ID parameter." });
    }

    try {
        // A. Verify if the book is actually marked as issued first
        const bookCheck = await pool.query('SELECT is_available FROM library_books WHERE id = $1', [book_id]);
        
        if (bookCheck.rows.length === 0) {
            return res.status(404).json({ error: "Book record not found." });
        }
        if (bookCheck.rows[0].is_available) {
            return res.status(400).json({ error: "This item is already back in stock." });
        }

        // B. Put the book back in inventory (is_available = true)
        await pool.query('UPDATE library_books SET is_available = TRUE WHERE id = $1', [book_id]);

        // C. Close out the transaction log with a return timestamp
        await pool.query(
            `UPDATE library_transactions 
             SET return_date = CURRENT_TIMESTAMP 
             WHERE book_id = $1 AND return_date IS NULL`,
            [book_id]
        );

        // 📢 Broadcast to both student and librarian screens that the inventory updated live
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