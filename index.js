const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const dotenv = require('dotenv');
const nodemailer = require('nodemailer');
const { body, validationResult } = require('express-validator');
const mongoose = require('mongoose');

// Load environment variables
dotenv.config();

const app = express();

// Security middleware
app.use(helmet({
    contentSecurityPolicy: false,
}));

// CORS configuration - more permissive for development
const corsOptions = {
    origin: function (origin, callback) {
        const allowedOrigins = [
            'http://localhost:3000',
            'http://127.0.0.1:5500',
            'http://localhost:5500',
            'https://midnight-backend-production.up.railway.app',
            process.env.FRONTEND_URL
        ].filter(Boolean);
        
        // Allow requests with no origin (like mobile apps, curl, etc)
        if (!origin) return callback(null, true);
        
        if (allowedOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV !== 'production') {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
    optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
    windowMs: (parseInt(process.env.RATE_LIMIT_WINDOW) || 15) * 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
    message: { success: false, message: 'Too many requests from this IP, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

app.use('/api/', limiter);

// ============= IN-MEMORY STORAGE FALLBACK =============
// Use this if MongoDB is not available
const inMemoryDB = {
    wishlist: [],
    get count() { return this.wishlist.length; },
    add(entry) {
        this.wishlist.push({
            ...entry,
            _id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
            createdAt: new Date()
        });
        return this.wishlist[this.wishlist.length - 1];
    },
    getTodayCount() {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        return this.wishlist.filter(item => new Date(item.createdAt) >= today).length;
    }
};

// ============= MONGODB CONNECTION =============
let Wishlist;
let useMemoryDB = false;

if (process.env.MONGODB_URI) {
    mongoose.connect(process.env.MONGODB_URI, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
        serverSelectionTimeoutMS: 5000, // Timeout after 5s instead of 30s
    })
    .then(() => {
        console.log('✅ MongoDB connected successfully');
        useMemoryDB = false;
    })
    .catch(err => {
        console.log('❌ MongoDB connection error:', err.message);
        console.log('⚠️  Falling back to in-memory storage');
        useMemoryDB = true;
    });

    // Wishlist Schema
    const wishlistSchema = new mongoose.Schema({
        name: { type: String, required: true },
        contact: { type: String, required: true },
        confirmed: { type: Boolean, default: true },
        createdAt: { type: Date, default: Date.now },
        ipAddress: String,
        userAgent: String
    });

    Wishlist = mongoose.model('Wishlist', wishlistSchema);
} else {
    console.log('⚠️  MONGODB_URI not found, using in-memory storage');
    useMemoryDB = true;
}

// ============= EMAIL CONFIGURATION =============
let transporter = null;

if (process.env.EMAIL_HOST && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    transporter = nodemailer.createTransport({
        host: process.env.EMAIL_HOST,
        port: parseInt(process.env.EMAIL_PORT) || 587,
        secure: process.env.EMAIL_PORT === '465',
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS,
        },
        tls: {
            rejectUnauthorized: false // Allow self-signed certificates
        },
        connectionTimeout: 5000,
        greetingTimeout: 5000,
        socketTimeout: 5000
    });

    // Verify email connection (don't await, just log)
    transporter.verify()
        .then(() => console.log('✅ Email server is ready'))
        .catch(err => {
            console.log('❌ Email server error:', err.message);
            console.log('⚠️  Continuing without email functionality');
            transporter = null;
        });
} else {
    console.log('⚠️  Email credentials not found, continuing without email functionality');
}

// Helper function to save to wishlist
async function saveToWishlist(data) {
    if (!useMemoryDB && Wishlist) {
        try {
            const entry = new Wishlist(data);
            return await entry.save();
        } catch (err) {
            console.log('❌ MongoDB save failed, falling back to memory:', err.message);
            useMemoryDB = true;
            return inMemoryDB.add(data);
        }
    } else {
        return inMemoryDB.add(data);
    }
}

// Helper function to get wishlist count
async function getWishlistCount() {
    if (!useMemoryDB && Wishlist) {
        try {
            return await Wishlist.countDocuments();
        } catch (err) {
            console.log('❌ MongoDB count failed, using memory:', err.message);
            useMemoryDB = true;
            return inMemoryDB.count;
        }
    } else {
        return inMemoryDB.count;
    }
}

// Helper function to get today's count
async function getTodayCount() {
    if (!useMemoryDB && Wishlist) {
        try {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            return await Wishlist.countDocuments({
                createdAt: { $gte: today }
            });
        } catch (err) {
            return inMemoryDB.getTodayCount();
        }
    } else {
        return inMemoryDB.getTodayCount();
    }
}

// ============= VALIDATION RULES =============
const validateWishlist = [
    body('name')
        .trim()
        .isLength({ min: 2, max: 50 })
        .withMessage('Name must be between 2 and 50 characters')
        .matches(/^[a-zA-Z\s'-]+$/)
        .withMessage('Name can only contain letters, spaces, apostrophes and hyphens'),
    body('contact')
        .trim()
        .notEmpty()
        .withMessage('Contact is required')
        .custom(value => {
            // Check if it's email or phone
            const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
            const isPhone = /^[\+]?[(]?[0-9]{3}[)]?[-\s\.]?[0-9]{3}[-\s\.]?[0-9]{4,6}$/.test(value);
            return isEmail || isPhone;
        })
        .withMessage('Please enter a valid email or phone number'),
    body('confirmed')
        .optional()
        .isBoolean()
        .withMessage('Invalid confirmation value')
];

// ============= ROUTES =============

// Health check
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'healthy',
        timestamp: new Date().toISOString(),
        storage: useMemoryDB ? 'memory' : 'mongodb',
        email: transporter ? 'configured' : 'disabled'
    });
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({ 
        status: 'active', 
        message: '🌙 Midnight API is running',
        version: '1.0.0',
        storage: useMemoryDB ? 'in-memory (fallback)' : 'mongodb',
        email: transporter ? 'enabled' : 'disabled',
        endpoints: {
            wishlist: '/api/wishlist (POST)',
            stats: '/api/stats (GET)',
            health: '/health (GET)'
        }
    });
});

// Wishlist endpoint
app.post('/api/wishlist', validateWishlist, async (req, res) => {
    try {
        // Check for validation errors
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ 
                success: false, 
                errors: errors.array() 
            });
        }

        const { name, contact, confirmed } = req.body;
        
        // Get IP and user agent
        const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const userAgent = req.headers['user-agent'];

        // Save to database (with fallback)
        const savedEntry = await saveToWishlist({
            name,
            contact,
            confirmed: confirmed !== false,
            ipAddress,
            userAgent
        });
        
        console.log(`✅ New wishlist entry: ${name} - ${contact} (${useMemoryDB ? 'memory' : 'mongodb'})`);

        // Get updated count
        const totalCount = await getWishlistCount();

        // Send emails in background (don't await)
        if (transporter) {
            // Admin email
            const adminMailOptions = {
                from: `"Midnight App" <${process.env.EMAIL_USER}>`,
                to: process.env.ADMIN_EMAIL || process.env.EMAIL_USER,
                subject: '🎉 New Midnight Wishlist Signup!',
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #000; color: #fff; padding: 30px; border-radius: 10px;">
                        <div style="text-align: center; margin-bottom: 30px;">
                            <h1 style="color: #1d9bf0; font-size: 36px; margin: 0;">🌙 MIDNIGHT</h1>
                            <p style="color: #71767b;">off the hook</p>
                        </div>
                        
                        <div style="background: #0a0a0a; border: 1px solid #2f3336; border-radius: 10px; padding: 25px;">
                            <h2 style="color: #fff; margin-top: 0;">New Wishlist Member! 🔥</h2>
                            
                            <div style="margin: 20px 0;">
                                <p style="margin: 10px 0;"><strong style="color: #1d9bf0;">Name:</strong> <span style="color: #fff;">${name}</span></p>
                                <p style="margin: 10px 0;"><strong style="color: #1d9bf0;">Contact:</strong> <span style="color: #fff;">${contact}</span></p>
                                <p style="margin: 10px 0;"><strong style="color: #1d9bf0;">Confirmed:</strong> <span style="color: ${confirmed ? '#00ba7c' : '#f4212e'};">${confirmed ? '✅ Yes' : '❌ No'}</span></p>
                                <p style="margin: 10px 0;"><strong style="color: #1d9bf0;">Time:</strong> <span style="color: #fff;">${new Date().toLocaleString()}</span></p>
                            </div>
                            
                            <div style="border-top: 1px solid #2f3336; margin: 20px 0;"></div>
                            
                            <p style="color: #71767b; font-size: 14px;">📍 IP: ${ipAddress}</p>
                            <p style="color: #71767b; font-size: 14px;">📱 Device: ${userAgent ? userAgent.substring(0, 100) : 'Unknown'}</p>
                            
                            <div style="text-align: center; margin-top: 25px;">
                                <p style="color: #fff; font-weight: bold;">Total signups: <span style="color: #1d9bf0;">${totalCount}</span></p>
                            </div>
                        </div>
                    </div>
                `
            };

            // Send admin email
            transporter.sendMail(adminMailOptions).catch(err => 
                console.log('Admin email error:', err.message)
            );

            // Send confirmation email to user if it's an email
            if (contact.includes('@')) {
                const userMailOptions = {
                    from: `"Midnight" <${process.env.EMAIL_USER}>`,
                    to: contact,
                    subject: '✅ You\'re on the Midnight wishlist!',
                    html: `
                        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #000; color: #fff; padding: 30px; border-radius: 10px;">
                            <div style="text-align: center; margin-bottom: 30px;">
                                <h1 style="color: #1d9bf0; font-size: 36px; margin: 10px 0;">MIDNIGHT</h1>
                            </div>
                            
                            <div style="background: #0a0a0a; border: 1px solid #2f3336; border-radius: 10px; padding: 25px;">
                                <h2 style="color: #fff; margin-top: 0;">Wagwan, ${name}! 🔥</h2>
                                
                                <p style="color: #e7e9ea; line-height: 1.6;">You don join the Midnight wishlist! As Larry Kush talk am: <strong style="color: #1d9bf0;">"you no dull at all!"</strong></p>
                                
                                <div style="background: #1d9bf0; color: #fff; padding: 15px; border-radius: 8px; margin: 25px 0; text-align: center;">
                                    <p style="margin: 0; font-size: 18px; font-weight: bold;">You are #${totalCount} on the list</p>
                                </div>
                                
                                <h3 style="color: #fff;">What next? 🚀</h3>
                                <ul style="color: #e7e9ea; padding-left: 20px;">
                                    <li>We go text you the moment app drop</li>
                                    <li>You get early access pass</li>
                                    <li>Be first to get booked</li>
                                </ul>
                                
                                <div style="border-top: 1px solid #2f3336; margin: 25px 0;"></div>
                                
                                <p style="color: #71767b; font-style: italic;">"Gbemidebe!" - we dey build sharp sharp for you.</p>
                                
                                <div style="text-align: center; margin-top: 30px;">
                                    <a href="${process.env.FRONTEND_URL || '#'}" style="background: #1d9bf0; color: #fff; text-decoration: none; padding: 12px 30px; border-radius: 30px; display: inline-block; font-weight: bold;">Visit Midnight</a>
                                </div>
                            </div>
                            
                            <p style="color: #71767b; font-size: 12px; text-align: center; margin-top: 20px;">© 2026 Midnight. All rights reserved. The internet, duuh?!</p>
                        </div>
                    `
                };

                transporter.sendMail(userMailOptions).catch(err => 
                    console.log('User email error:', err.message)
                );
            }
        }

        // Return success response
        res.status(200).json({
            success: true,
            message: 'Successfully joined wishlist!',
            data: {
                name,
                contact: contact.includes('@') ? 'email' : 'phone',
                position: totalCount,
                storage: useMemoryDB ? 'memory' : 'mongodb'
            }
        });

    } catch (error) {
        console.error('❌ Wishlist error:', error);
        res.status(500).json({
            success: false,
            message: 'Something went wrong. Please try again.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Get wishlist stats
app.get('/api/stats', async (req, res) => {
    try {
        const total = await getWishlistCount();
        const today = await getTodayCount();
        
        res.json({
            success: true,
            data: {
                total,
                today,
                message: `${total} people no dull!`,
                storage: useMemoryDB ? 'memory' : 'mongodb'
            }
        });
    } catch (error) {
        console.error('Stats error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error fetching stats',
            data: {
                total: useMemoryDB ? inMemoryDB.count : 250,
                today: useMemoryDB ? inMemoryDB.getTodayCount() : 0
            }
        });
    }
});

// OPTIONS handler for CORS preflight
app.options('*', cors(corsOptions));

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('❌ Server error:', err.stack);
    res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: 'Route not found'
    });
});

// Start server
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
    console.log(`🚀 Midnight backend running on port ${PORT}`);
    console.log(`📝 Storage mode: ${useMemoryDB ? 'IN-MEMORY (fallback)' : 'MONGODB'}`);
    console.log(`📧 Email: ${transporter ? 'enabled' : 'disabled'}`);
    console.log(`📍 Local: http://localhost:${PORT}`);
    console.log(`📊 Stats endpoint: http://localhost:${PORT}/api/stats`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
        mongoose.connection.close(false, () => {
            console.log('MongoDB connection closed');
            process.exit(0);
        });
    });
});

module.exports = app;