const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');

// Create Turso client - force HTTPS for reliable connections on hosted platforms
const rawUrl = process.env.TURSO_DATABASE_URL || 'file:local.db';
const dbUrl = rawUrl.startsWith('libsql://') ? rawUrl.replace('libsql://', 'https://') : rawUrl;
const db = createClient({
    url: dbUrl,
    authToken: process.env.TURSO_AUTH_TOKEN
});

console.log('Database connected:', dbUrl.startsWith('https://') ? 'Turso (cloud)' : 'local file');

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

    // Create files table with Cloudinary support
    await db.execute(`
        CREATE TABLE IF NOT EXISTS files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            exam_id INTEGER NOT NULL,
            display_name TEXT NOT NULL,
            filename TEXT NOT NULL,
            file_url TEXT,
            public_id TEXT,
            file_type TEXT NOT NULL,
            sort_order INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE
        )
    `);

    // Repository table for standalone file management with Cloudinary support
    await db.execute(`
        CREATE TABLE IF NOT EXISTS repo_files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            display_name TEXT NOT NULL,
            filename TEXT NOT NULL,
            file_url TEXT,
            public_id TEXT,
            file_type TEXT NOT NULL,
            category TEXT NOT NULL,
            related_stem_id INTEGER,
            specialty TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (related_stem_id) REFERENCES repo_files(id) ON DELETE SET NULL
        )
    `);

    // Residents table - tracks all residents across years
    await db.execute(`
        CREATE TABLE IF NOT EXISTS residents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            pgy_level INTEGER NOT NULL,
            start_year INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'graduated', 'research')),
            email TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Links residents to exams with auto-generated credentials
    await db.execute(`
        CREATE TABLE IF NOT EXISTS exam_residents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            exam_id INTEGER NOT NULL,
            resident_id INTEGER NOT NULL,
            credential_id INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
            FOREIGN KEY (resident_id) REFERENCES residents(id) ON DELETE CASCADE,
            FOREIGN KEY (credential_id) REFERENCES credentials(id) ON DELETE SET NULL,
            UNIQUE(exam_id, resident_id)
        )
    `);

    // Assigns residents to rooms within an exam
    await db.execute(`
        CREATE TABLE IF NOT EXISTS exam_room_assignments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            exam_id INTEGER NOT NULL,
            resident_id INTEGER NOT NULL,
            room_number INTEGER NOT NULL,
            FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
            FOREIGN KEY (resident_id) REFERENCES residents(id) ON DELETE CASCADE,
            UNIQUE(exam_id, resident_id, room_number)
        )
    `);

    // Exam rooms - explicit room entity within each exam
    await db.execute(`
        CREATE TABLE IF NOT EXISTS exam_rooms (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            exam_id INTEGER NOT NULL,
            room_number INTEGER NOT NULL,
            room_name TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
            UNIQUE(exam_id, room_number)
        )
    `);

    // Faculty directory - all attending surgeons
    await db.execute(`
        CREATE TABLE IF NOT EXISTS faculty (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT,
            department TEXT DEFAULT 'Surgery',
            status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'inactive')),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Examiners - separate login for faculty running exam rooms
    await db.execute(`
        CREATE TABLE IF NOT EXISTS examiners (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            exam_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            username TEXT NOT NULL,
            password TEXT NOT NULL,
            room_number INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
            UNIQUE(username)
        )
    `);

    // Exam scores - examiner grades per question per resident
    await db.execute(`
        CREATE TABLE IF NOT EXISTS exam_scores (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            exam_id INTEGER NOT NULL,
            resident_id INTEGER NOT NULL,
            file_id INTEGER,
            repository_stem_id INTEGER,
            question_name TEXT NOT NULL,
            score TEXT NOT NULL CHECK(score IN ('pass', 'marginal', 'fail')),
            comments TEXT,
            examiner_name TEXT,
            room_number INTEGER,
            scored_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
            FOREIGN KEY (resident_id) REFERENCES residents(id) ON DELETE CASCADE,
            FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE SET NULL,
            FOREIGN KEY (repository_stem_id) REFERENCES repo_files(id) ON DELETE SET NULL
        )
    `);

    // Question tracking table - tracks which stems each resident has been tested on
    await db.execute(`
        CREATE TABLE IF NOT EXISTS question_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            resident_id INTEGER,
            resident_name TEXT NOT NULL,
            exam_id INTEGER NOT NULL,
            repository_stem_id INTEGER,
            stem_display_name TEXT NOT NULL,
            specialty TEXT,
            room_number INTEGER,
            recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            recorded_by TEXT DEFAULT 'manual',
            FOREIGN KEY (resident_id) REFERENCES residents(id) ON DELETE SET NULL,
            FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
            FOREIGN KEY (repository_stem_id) REFERENCES repo_files(id) ON DELETE SET NULL
        )
    `);

    // Add columns to existing tables if they don't exist (migration)
    try {
        await db.execute('ALTER TABLE files ADD COLUMN file_url TEXT');
    } catch (e) { /* column may already exist */ }
    try {
        await db.execute('ALTER TABLE files ADD COLUMN public_id TEXT');
    } catch (e) { /* column may already exist */ }
    try {
        await db.execute('ALTER TABLE files ADD COLUMN room_number INTEGER');
    } catch (e) { /* column may already exist */ }
    try {
        await db.execute('ALTER TABLE files ADD COLUMN item_number INTEGER');
    } catch (e) { /* column may already exist */ }
    try {
        await db.execute('ALTER TABLE files ADD COLUMN item_type TEXT');
    } catch (e) { /* column may already exist */ }
    try {
        await db.execute('ALTER TABLE repo_files ADD COLUMN file_url TEXT');
    } catch (e) { /* column may already exist */ }
    try {
        await db.execute('ALTER TABLE repo_files ADD COLUMN public_id TEXT');
    } catch (e) { /* column may already exist */ }
    try {
        await db.execute('ALTER TABLE repo_files ADD COLUMN specialty TEXT');
    } catch (e) { /* column may already exist */ }
    try {
        await db.execute('ALTER TABLE files ADD COLUMN assigned_examiner_id INTEGER REFERENCES examiners(id) ON DELETE SET NULL');
    } catch (e) { /* column may already exist */ }
    try {
        await db.execute('ALTER TABLE exams ADD COLUMN start_time DATETIME');
    } catch (e) { /* column may already exist */ }
    try {
        await db.execute('ALTER TABLE examiners ADD COLUMN email TEXT');
    } catch (e) { /* column may already exist */ }
    try {
        await db.execute('ALTER TABLE question_history ADD COLUMN resident_id INTEGER REFERENCES residents(id) ON DELETE SET NULL');
    } catch (e) { /* column may already exist */ }
    try {
        await db.execute('ALTER TABLE credentials ADD COLUMN resident_id INTEGER REFERENCES residents(id) ON DELETE SET NULL');
    } catch (e) { /* column may already exist */ }

    // Session store table
    await db.execute(`
        CREATE TABLE IF NOT EXISTS sessions (
            sid TEXT PRIMARY KEY,
            sess TEXT NOT NULL,
            expired DATETIME NOT NULL
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
        console.log('Default admin created — change the password immediately via Admin Settings.');
    }

    // Check for password reset via environment variable
    if (process.env.ADMIN_RESET_PASSWORD) {
        const newHash = bcrypt.hashSync(process.env.ADMIN_RESET_PASSWORD, 10);
        await db.execute({
            sql: 'UPDATE admins SET password_hash = ? WHERE username = ?',
            args: [newHash, 'admin']
        });
        console.log('Admin password has been reset via ADMIN_RESET_PASSWORD environment variable');
        console.log('IMPORTANT: Remove the ADMIN_RESET_PASSWORD variable from your environment after logging in!');
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
