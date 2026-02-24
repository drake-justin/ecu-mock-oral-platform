const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

// Ensure data and uploads directories exist
const dataDir = path.join(__dirname, 'data');
const uploadsDir = path.join(__dirname, 'uploads');

if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'database.sqlite');
const db = new Database(dbPath);

// Enable foreign keys
db.pragma('foreign_keys = ON');

// Create tables immediately (before preparing statements)
db.exec(`
    CREATE TABLE IF NOT EXISTS admins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS exams (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        date DATE,
        is_active BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS credentials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        exam_id INTEGER NOT NULL,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        examinee_name TEXT,
        is_used BOOLEAN DEFAULT 0,
        used_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE
    )
`);

db.exec(`
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
db.exec(`
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
function initializeDatabase() {
    const adminCount = db.prepare('SELECT COUNT(*) as count FROM admins').get();
    if (adminCount.count === 0) {
        const passwordHash = bcrypt.hashSync('admin123', 10);
        db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run('admin', passwordHash);
        console.log('Default admin created - Username: admin, Password: admin123');
    }
}

// Admin queries
const adminQueries = {
    findByUsername: db.prepare('SELECT * FROM admins WHERE username = ?'),
    create: db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)'),
    updatePassword: db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?')
};

// Exam queries
const examQueries = {
    findAll: db.prepare('SELECT * FROM exams ORDER BY created_at DESC'),
    findById: db.prepare('SELECT * FROM exams WHERE id = ?'),
    findActive: db.prepare('SELECT * FROM exams WHERE is_active = 1 LIMIT 1'),
    create: db.prepare('INSERT INTO exams (name, date, is_active) VALUES (?, ?, ?)'),
    update: db.prepare('UPDATE exams SET name = ?, date = ?, is_active = ? WHERE id = ?'),
    delete: db.prepare('DELETE FROM exams WHERE id = ?'),
    setActive: db.prepare('UPDATE exams SET is_active = ? WHERE id = ?'),
    deactivateAll: db.prepare('UPDATE exams SET is_active = 0')
};

// Credential queries
const credentialQueries = {
    findByExam: db.prepare('SELECT * FROM credentials WHERE exam_id = ? ORDER BY username'),
    findByUsername: db.prepare('SELECT c.*, e.name as exam_name FROM credentials c JOIN exams e ON c.exam_id = e.id WHERE c.username = ?'),
    findById: db.prepare('SELECT * FROM credentials WHERE id = ?'),
    create: db.prepare('INSERT INTO credentials (exam_id, username, password, examinee_name) VALUES (?, ?, ?, ?)'),
    markUsed: db.prepare('UPDATE credentials SET is_used = 1, used_at = CURRENT_TIMESTAMP WHERE id = ?'),
    reset: db.prepare('UPDATE credentials SET is_used = 0, used_at = NULL WHERE id = ?'),
    delete: db.prepare('DELETE FROM credentials WHERE id = ?'),
    deleteByExam: db.prepare('DELETE FROM credentials WHERE exam_id = ?'),
    countByExam: db.prepare('SELECT COUNT(*) as total, SUM(is_used) as used FROM credentials WHERE exam_id = ?'),
    getStats: db.prepare(`
        SELECT e.id, e.name,
               COUNT(c.id) as total_credentials,
               SUM(CASE WHEN c.is_used = 1 THEN 1 ELSE 0 END) as used_credentials
        FROM exams e
        LEFT JOIN credentials c ON e.id = c.exam_id
        GROUP BY e.id
        ORDER BY e.created_at DESC
    `)
};

// File queries (exam-linked files)
const fileQueries = {
    findByExam: db.prepare('SELECT * FROM files WHERE exam_id = ? ORDER BY sort_order, id'),
    findById: db.prepare('SELECT * FROM files WHERE id = ?'),
    create: db.prepare('INSERT INTO files (exam_id, display_name, filename, file_type, sort_order) VALUES (?, ?, ?, ?, ?)'),
    update: db.prepare('UPDATE files SET display_name = ?, sort_order = ? WHERE id = ?'),
    delete: db.prepare('DELETE FROM files WHERE id = ?'),
    deleteByExam: db.prepare('DELETE FROM files WHERE exam_id = ?'),
    getMaxSortOrder: db.prepare('SELECT MAX(sort_order) as max_order FROM files WHERE exam_id = ?')
};

// Repository queries (standalone file management)
const repositoryQueries = {
    findAll: db.prepare(`
        SELECT r.*,
               s.display_name as stem_name
        FROM repository r
        LEFT JOIN repository s ON r.related_stem_id = s.id
        ORDER BY r.created_at DESC
    `),
    findStems: db.prepare(`SELECT * FROM repository WHERE category = 'stem' ORDER BY display_name`),
    findById: db.prepare('SELECT * FROM repository WHERE id = ?'),
    findByStemId: db.prepare(`SELECT * FROM repository WHERE related_stem_id = ?`),
    create: db.prepare('INSERT INTO repository (display_name, filename, file_type, category, related_stem_id) VALUES (?, ?, ?, ?, ?)'),
    update: db.prepare('UPDATE repository SET display_name = ? WHERE id = ?'),
    updateRelatedStem: db.prepare('UPDATE repository SET related_stem_id = ? WHERE id = ?'),
    delete: db.prepare('DELETE FROM repository WHERE id = ?'),
    clearRelatedStem: db.prepare('UPDATE repository SET related_stem_id = NULL WHERE related_stem_id = ?'),
    getWithRelatedImages: db.prepare(`
        SELECT r.*,
               GROUP_CONCAT(ci.id) as image_ids,
               GROUP_CONCAT(ci.display_name) as image_names
        FROM repository r
        LEFT JOIN repository ci ON ci.related_stem_id = r.id
        WHERE r.category = 'stem'
        GROUP BY r.id
        ORDER BY r.display_name
    `)
};

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
    adminQueries,
    examQueries,
    credentialQueries,
    fileQueries,
    repositoryQueries,
    generatePassword,
    generateUsername
};
