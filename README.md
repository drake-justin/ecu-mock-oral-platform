# ECU Mock Oral Platform

A web application for conducting mock oral examinations where residents receive one-time login credentials on exam day to access question stems and images.

## Features

- **One-time credentials**: Login codes are invalidated after first use
- **Admin panel**: Manage exams, credentials, and files
- **Bulk credential generation**: Generate multiple credentials with printable cards
- **File management**: Upload PDFs and images with drag-and-drop
- **Rate limiting**: Protection against brute-force login attempts

## Quick Start

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the server:
   ```bash
   node server.js
   ```

3. Access the application:
   - Examinee login: http://localhost:3000
   - Admin panel: http://localhost:3000/admin/login

## Default Admin Credentials

- **Username**: `admin`
- **Password**: `admin123`

> Change these credentials after first login in production!

## Technology Stack

- **Backend**: Node.js + Express.js
- **Database**: SQLite (better-sqlite3)
- **Frontend**: Vanilla HTML, CSS, JavaScript
- **Authentication**: Express sessions with bcrypt

## Project Structure

```
├── server.js              # Express server
├── database.js            # SQLite setup and queries
├── middleware/
│   └── auth.js            # Authentication middleware
├── routes/
│   ├── auth.js            # Login/logout routes
│   ├── admin.js           # Admin panel routes
│   └── exam.js            # Examinee exam routes
├── views/                 # HTML templates
├── public/css/            # Stylesheets
├── uploads/               # Uploaded files
└── data/                  # SQLite database
```

## Deployment

This application requires a persistent filesystem for SQLite and file uploads. Recommended platforms:
- Railway
- Render
- DigitalOcean App Platform
- Any VPS with Node.js

## License

MIT
