const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');

// Create Turso client
const db = createClient({
    url: process.env.TURSO_DATABASE_URL || 'file:local.db',
    authToken: process.env.TURSO_AUTH_TOKEN
});

// Initialize database schema
async function initializeDatabase() {
    // Create admins table
    await db.execute(`
        CREATE TABLE IF NOT EXISTS admins (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Create exams table
    await db.execute(`
        CREATE TABLE IF NOT EXISTS exams (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            date DATE,
            is_active INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Create credentials table
    await db.execute(`
        CREATE TABLE IF NOT EXISTS credentials (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            exam_id INTEGER NOT NULL,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            examinee_name TEXT,
            is_used INTEGER DEFAULT 0,
            used_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE
        )
    `);

    // Create files table
    await db.execute(`
        CREATE TABLE IF NOT EXISTS files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            exam_id INTEGER NOT NULL,
            display_name TEXT NOT NULL,
            filename TEXT NOT NULL,
            file_type TEXT NOT NULL,
            sort_order INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE
        )
    `);

    // Repository table for standalone file management
    await db.execute(`
        CREATE TABLE IF NOT EXISTS repository (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            display_name TEXT NOT NULL,
            filename TEXT NOT NULL,
            file_type TEXT NOT NULL,
            category TEXT NOT NULL CHECK(category IN ('stem', 'clinical_image')),
            related_stem_id INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (related_stem_id) REFERENCES repository(id) ON DELETE SET NULL
        )
    `);

    // Create default admin if none exists
    const result = await db.execute('SELECT COUNT(*) as count FROM admins');
    if (result.rows[0].count === 0) {
        const passwordHash = bcrypt.hashSync('admin123', 10);
        await db.execute({
            sql: 'INSERT INTO admins (username, password_hash) VALUES (?, ?)',
            args: ['admin', passwordHash]
        });
        console.log('Default admin created - Username: admin, Password: admin123');
    }
}

// Helper function to generate random password
function generatePassword() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let password = '';
    for (let i = 0; i < 4; i++) {
        password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    password += '-';
    for (let i = 0; i < 4; i++) {
        password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
}

// Helper function to generate username
function generateUsername(examId, index) {
    return `EXAM${examId.toString().padStart(2, '0')}${index.toString().padStart(3, '0')}`;
}

module.exports = {
    db,
    initializeDatabase,
    generatePassword,
    generateUsername
};
