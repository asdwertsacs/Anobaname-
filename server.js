const express = require("express");
const session = require("express-session");
const multer = require("multer");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const app = express();
const PORT = 3000;

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));
app.use(
    session({
        secret: "librarysecret",
        resave: false,
        saveUninitialized: true,
    })
);
app.set("view engine", "ejs");

// Database with FULLMUTEX (avoids SQLITE_BUSY)
const db = new sqlite3.Database(
    "./library.db",
    sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE | sqlite3.OPEN_FULLMUTEX,
    (err) => {
        if (err) console.error("❌ DB connection error:", err);
        else console.log("✅ Connected to SQLite database.");
    }
);

// Enable WAL mode (better concurrency)
db.serialize(() => {
    db.run("PRAGMA journal_mode = WAL;");
});

// Multer setup for book images
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, "./public/images"),
    filename: (req, file, cb) =>
        cb(null, Date.now() + path.extname(file.originalname)),
});
const upload = multer({ storage });

// Ensure tables
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        role TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS books (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT,
        author TEXT,
        image TEXT,
        available INTEGER
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id INTEGER NOT NULL,
        book_title TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        borrow_date TEXT NOT NULL,
        return_date TEXT
    )`);
});

// Routes

// Home → Login
app.get("/", (req, res) => res.redirect("/login"));

// Login
app.get("/login", (req, res) => res.render("login", { error: null }));
app.post("/login", (req, res) => {
    const { username, password } = req.body;
    db.get(
        "SELECT * FROM users WHERE username=? AND password=?",
        [username, password],
        (err, user) => {
            if (!user) return res.render("login", { error: "Invalid credentials" });
            req.session.user = user;
            res.redirect("/dashboard");
        }
    );
});

// Register
app.get("/register", (req, res) => res.render("register", { error: null }));
app.post("/register", (req, res) => {
    const { username, password, role } = req.body;
    db.run(
        "INSERT INTO users(username,password,role) VALUES (?,?,?)",
        [username, password, role],
        function (err) {
            if (err) return res.render("register", { error: "Username already exists" });
            res.redirect("/login");
        }
    );
});

// Dashboard (available books + borrowed logs for librarian)
app.get("/dashboard", (req, res) => {
    if (!req.session.user) return res.redirect("/login");

    db.all("SELECT * FROM books WHERE available=1 ORDER BY title ASC", [], (err, books) => {
        if (req.session.user.role === 'librarian') {
            // Get borrowed books logs
            const query = `
                SELECT logs.id, logs.book_id, logs.book_title, logs.borrow_date, users.username
                FROM logs
                JOIN users ON logs.user_id = users.id
                WHERE logs.return_date IS NULL
            `;
            db.all(query, [], (err, borrowedBooks) => {
                res.render("dashboard", {
                    user: req.session.user,
                    books,
                    borrowedBooks
                });
            });
        } else {
            res.render("dashboard", { user: req.session.user, books, borrowedBooks: [] });
        }
    });
});

// Borrow Logs - Librarian only
app.get("/logs", (req, res) => {
    if (!req.session.user || req.session.user.role !== "librarian")
        return res.redirect("/dashboard");

    const query = `
        SELECT logs.id, logs.book_title, users.username AS user, logs.borrow_date AS timestamp
        FROM logs
        INNER JOIN users ON logs.user_id = users.id
        ORDER BY logs.borrow_date DESC
    `;

    db.all(query, [], (err, logs) => {
        if (err) return res.status(500).send("Server error");
        res.render("logs", { user: req.session.user, logs });
    });
});

// Users - Librarian only
app.get("/users", (req, res) => {
    if (!req.session.user || req.session.user.role !== "librarian")
        return res.redirect("/dashboard");

    db.all("SELECT id, username, role FROM users ORDER BY id ASC", [], (err, users) => {
        if (err) return res.status(500).send("Server error");
        res.render("users", { user: req.session.user, users });
    });
});

// Add Book (Librarian only)
app.post("/add-book", upload.single("image"), (req, res) => {
    if (!req.session.user || req.session.user.role !== "librarian")
        return res.redirect("/dashboard");

    const { title, author } = req.body;
    const image = req.file ? req.file.filename : "book_placeholder.jpg";
    db.run(
        "INSERT INTO books(title,author,image,available) VALUES (?,?,?,1)",
        [title, author, image],
        () => res.redirect("/dashboard")
    );
});

// Borrow Book
app.post("/borrow-book", (req, res) => {
    if (!req.session.user) return res.status(401).send("Unauthorized");

    const { book_id } = req.body;
    const userId = req.session.user.id;

    db.get("SELECT * FROM books WHERE id=? AND available=1", [book_id], (err, book) => {
        if (!book) return res.status(400).send("Book unavailable");
        const now = new Date().toLocaleString();

        db.serialize(() => {
            db.run("UPDATE books SET available=0 WHERE id=?", [book_id], function (err) {
                if (err) return res.status(500).send("Error updating book");
                db.run(
                    "INSERT INTO logs(book_id,book_title,user_id,borrow_date,return_date) VALUES (?,?,?,?,NULL)",
                    [book.id, book.title, userId, now],
                    function (err) {
                        if (err) return res.status(500).send("Error logging borrow");
                        res.status(200).send("Borrowed successfully");
                    }
                );
            });
        });
    });
});

// Return Book
app.post("/return-book", (req, res) => {
    if (!req.session.user) return res.redirect("/login");

    const { book_id } = req.body;
    const userId = req.session.user.id;
    const now = new Date().toLocaleString();

    db.serialize(() => {
        db.run("UPDATE books SET available=1 WHERE id=?", [book_id]);
        db.run(
            "UPDATE logs SET return_date=? WHERE book_id=? AND user_id=? AND return_date IS NULL",
            [now, book_id, userId],
            () => res.redirect("/my-books")
        );
    });
});

// My Borrowed Books (FIXED to use logs)
app.get("/my-books", (req, res) => {
    if (!req.session.user) return res.redirect("/login");

    const userId = req.session.user.id;

    const query = `
        SELECT books.id, books.title, books.author, books.image
        FROM books
        JOIN logs ON books.id = logs.book_id
        WHERE logs.user_id = ? AND logs.return_date IS NULL
    `;

    db.all(query, [userId], (err, rows) => {
        if (err) {
            console.error("Error fetching borrowed books:", err.message);
            return res.status(500).send("Server error");
        }

        res.render("my-books", {
            user: req.session.user,
            borrowedBooks: rows
        });
    });
});

// Logout
app.get("/logout", (req, res) => {
    req.session.destroy();
    res.redirect("/login");
});

// Start server
app.listen(PORT, () =>
    console.log(`🚀 Server running at http://localhost:${PORT}`)
);
