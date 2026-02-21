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
});

app.use('/api/', limiter);

// MongoDB connection (optional - if you want to store wishlist)
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ MongoDB connected'))
    .catch(err => console.log('❌ MongoDB connection error:', err));

// Wishlist Schema (optional)
const wishlistSchema = new mongoose.Schema({
    name: { type: String, required: true },
    contact: { type: String, required: true },
    confirmed: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now },
    ipAddress: String,
    userAgent: String
});

const Wishlist = mongoose.model('Wishlist', wishlistSchema);

// Email configuration
const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT,
    secure: false,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
    tls: {
        rejectUnauthorized: false
    }
});

// Verify email connection
transporter.verify((error, success) => {
    if (error) {
        console.log('❌ Email server error:', error);
    } else {
        console.log('✅ Email server is ready');
    }
});

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

// Routes
app.get('/', (req, res) => {
    res.json({ 
        status: 'active', 
        message: 'Midnight API is running',
        version: '1.0.0',
        endpoints: {
            wishlist: '/api/wishlist',
            stats: '/api/stats'
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

        // Save to database (optional)
        const wishlistEntry = new Wishlist({
            name,
            contact,
            confirmed,
            ipAddress,
            userAgent
        });
        
        await wishlistEntry.save();
        console.log(`✅ New wishlist entry: ${name} - ${contact}`);

        // Send email notification to admin
        const adminMailOptions = {
            from: `"Midnight App" <${process.env.EMAIL_USER}>`,
            to: process.env.ADMIN_EMAIL,
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
                            <p style="color: #fff; font-weight: bold;">Total signups: <span style="color: #1d9bf0;">${await Wishlist.countDocuments()}</span></p>
                        </div>
                    </div>
                </div>
            `
        };

        // Send confirmation email to user
        const userMailOptions = {
            from: `"Midnight" <${process.env.EMAIL_USER}>`,
            to: contact,
            subject: '✅ You\'re on the Midnight wishlist!',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #000; color: #fff; padding: 30px; border-radius: 10px;">
                    <div style="text-align: center; margin-bottom: 30px;">
                        <i class="fas fa-moon" style="font-size: 48px; color: #1d9bf0;"></i>
                        <h1 style="color: #1d9bf0; font-size: 36px; margin: 10px 0;">MIDNIGHT</h1>
                    </div>
                    
                    <div style="background: #0a0a0a; border: 1px solid #2f3336; border-radius: 10px; padding: 25px;">
                        <h2 style="color: #fff; margin-top: 0;">Wagwan, ${name}! 🔥</h2>
                        
                        <p style="color: #e7e9ea; line-height: 1.6;">You don join the Midnight wishlist! As Larry Kush talk am: <strong style="color: #1d9bf0;">"you no dull at all!"</strong></p>
                        
                        <div style="background: #1d9bf0; color: #fff; padding: 15px; border-radius: 8px; margin: 25px 0; text-align: center;">
                            <p style="margin: 0; font-size: 18px; font-weight: bold;">You are #${await Wishlist.countDocuments()} on the list</p>
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
                            <a href="${process.env.FRONTEND_URL}" style="background: #1d9bf0; color: #fff; text-decoration: none; padding: 12px 30px; border-radius: 30px; display: inline-block; font-weight: bold;">Visit Midnight</a>
                        </div>
                    </div>
                    
                    <p style="color: #71767b; font-size: 12px; text-align: center; margin-top: 20px;">© 2026 Midnight. All rights reserved. The internet, duuh?!</p>
                </div>
            `
        };

        // Send emails (don't await to not block response)
        transporter.sendMail(adminMailOptions).catch(err => console.log('Admin email error:', err));
        
        // Only send user email if it's a valid email (not phone)
        if (contact.includes('@')) {
            transporter.sendMail(userMailOptions).catch(err => console.log('User email error:', err));
        }

        // Return success response
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
            message: 'Something went wrong. Please try again.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
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

// Health check for Railway
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'healthy' });
});

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
app.listen(PORT, () => {
    console.log(`🚀 Midnight backend running on port ${PORT}`);
    console.log(`📝 Wishlist endpoint: http://localhost:${PORT}/api/wishlist`);
    console.log(`📊 Stats endpoint: http://localhost:${PORT}/api/stats`);
});