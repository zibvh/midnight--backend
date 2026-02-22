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

// FIX #1: Trust proxy (for rate limiting with x-forwarded-for)
app.set('trust proxy', 1);

// Security middleware
app.use(helmet({
    contentSecurityPolicy: false,
}));

// CORS configuration
const corsOptions = {
    origin: ['http://localhost:3000', 'http://127.0.0.1:5500', process.env.FRONTEND_URL].filter(Boolean),
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW) * 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_MAX),
    message: 'Too many requests from this IP, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        // FIX #2: Better IP detection for Railway
        return req.headers['x-forwarded-for'] || req.ip || req.connection.remoteAddress;
    }
});

app.use('/api/', limiter);

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ MongoDB connected successfully'))
    .catch(err => console.log('❌ MongoDB connection error:', err));

// Wishlist Schema
const wishlistSchema = new mongoose.Schema({
    name: { type: String, required: true },
    contact: { type: String, required: true },
    confirmed: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now },
    ipAddress: String,
    userAgent: String
});

const Wishlist = mongoose.model('Wishlist', wishlistSchema);

// Email configuration with better timeout handling
let transporter;
try {
    transporter = nodemailer.createTransport({
        host: process.env.EMAIL_HOST || 'smtp.gmail.com',
        port: parseInt(process.env.EMAIL_PORT) || 587,
        secure: false, // false for port 587
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS,
        },
        tls: {
            rejectUnauthorized: false,
            ciphers: 'SSLv3'
        },
        connectionTimeout: 30000, // 30 seconds
        socketTimeout: 30000,
        debug: true // Enable debug logs
    });

    // Verify email connection
    transporter.verify((error, success) => {
        if (error) {
            console.log('❌ Email server error:', error.message);
            console.log('⚠️ Continuing without email - app will still work!');
        } else {
            console.log('✅ Email server is ready');
        }
    });
} catch (error) {
    console.log('❌ Email configuration error:', error.message);
    transporter = null;
}

// Validation rules
const validateWishlist = [
    body('name')
        .trim()
        .isLength({ min: 2, max: 50 })
        .withMessage('Name must be between 2 and 50 characters')
        .matches(/^[a-zA-Z\s]+$/)
        .withMessage('Name can only contain letters and spaces'),
    body('contact')
        .trim()
        .custom(value => {
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

// Routes
app.get('/', (req, res) => {
    res.json({ 
        status: 'active', 
        message: 'Midnight API is running',
        version: '1.0.0',
        endpoints: {
            wishlist: '/api/wishlist',
            stats: '/api/stats',
            health: '/health'
        }
    });
});

// Health check
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'healthy',
        mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
        email: transporter ? 'configured' : 'disabled'
    });
});

// Wishlist endpoint
app.post('/api/wishlist', validateWishlist, async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ 
                success: false, 
                errors: errors.array() 
            });
        }

        const { name, contact, confirmed } = req.body;
        
        const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const userAgent = req.headers['user-agent'];

        const wishlistEntry = new Wishlist({
            name,
            contact,
            confirmed,
            ipAddress,
            userAgent
        });
        
        await wishlistEntry.save();
        console.log(`✅ New wishlist entry: ${name} - ${contact}`);

        // Send emails if transporter exists (don't await - fire and forget)
        if (transporter) {
            // Send admin notification
            const adminMailOptions = {
                from: `"Midnight App" <${process.env.EMAIL_USER}>`,
                to: process.env.ADMIN_EMAIL,
                subject: '🎉 New Midnight Wishlist Signup!',
                html: `<div>New signup: ${name} - ${contact}</div>`
            };
            
            transporter.sendMail(adminMailOptions).catch(err => 
                console.log('Admin email error:', err.message)
            );

            // Send to user if email
            if (contact.includes('@')) {
                const userMailOptions = {
                    from: `"Midnight" <${process.env.EMAIL_USER}>`,
                    to: contact,
                    subject: '✅ You\'re on the Midnight wishlist!',
                    html: `<div>Thanks ${name}! You're on the wishlist!</div>`
                };
                
                transporter.sendMail(userMailOptions).catch(err => 
                    console.log('User email error:', err.message)
                );
            }
        }

        res.status(200).json({
            success: true,
            message: 'Successfully joined wishlist!',
            data: {
                name,
                contact: contact.includes('@') ? 'email' : 'phone',
                position: await Wishlist.countDocuments()
            }
        });

    } catch (error) {
        console.error('❌ Wishlist error:', error);
        res.status(500).json({
            success: false,
            message: 'Something went wrong. Please try again.'
        });
    }
});

// Get wishlist stats
app.get('/api/stats', async (req, res) => {
    try {
        const total = await Wishlist.countDocuments();
        const today = await Wishlist.countDocuments({
            createdAt: { $gte: new Date().setHours(0, 0, 0, 0) }
        });
        
        res.json({
            success: true,
            data: {
                total,
                today,
                message: `${total} people no dull!`
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching stats' });
    }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Midnight backend running on port ${PORT}`);
    console.log(`📝 Storage mode: MONGODB`);
    console.log(`📧 Email: ${transporter ? 'enabled' : 'disabled'}`);
    console.log(`🌍 Local: http://localhost:${PORT}`);
    console.log(`📊 Stats endpoint: http://localhost:${PORT}/api/stats`);
});