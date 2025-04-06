const express = require('express');
const axios = require('axios');
const querystring = require('querystring');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const { MongoClient } = require('mongodb');
const crypto = require('crypto');
require('dotenv').config();

// MongoDB Connection
const MONGODB_URI = `mongodb+srv://hoachau1010:KFNgjpacRTFb03zb@hoa.1xyra5m.mongodb.net/spotifydb?retryWrites=true&w=majority&tlsAllowInvalidHostnames=true`;
const DB_NAME = 'spotifydb';
const COLLECTION_NAME = 'spotify_tokens';
const TOKEN_ID = 'main_spotify_token';

let mongoClient = null;
let tokenData = null;

// Function to connect to MongoDB
async function connectToMongoDB() {
  if (mongoClient) return mongoClient;
  
  try {
    console.log('Connecting to MongoDB with URI:', MONGODB_URI);
    mongoClient = new MongoClient(MONGODB_URI);
    await mongoClient.connect();
    console.log('Successfully connected to MongoDB');
    return mongoClient;
  } catch (error) {
    console.error('Failed to connect to MongoDB:', error);
    throw error;
  }
}

// Function to load tokens from database
async function loadTokenFromDB() {
  try {
    const client = await connectToMongoDB();
    const db = client.db(DB_NAME);
    const collection = db.collection(COLLECTION_NAME);
    
    console.log('Attempting to load tokens from database');
    const tokenDoc = await collection.findOne({ _id: TOKEN_ID });
    
    if (tokenDoc) {
      console.log('Tokens found in database');
      return tokenDoc.tokenData;
    }
    console.log('No tokens found in database');
    return null;
  } catch (error) {
    console.error('Error loading tokens from database:', error);
    return null;
  }
}

// Function to save tokens to database
async function saveTokenToDB(tokens) {
  try {
    console.log('Attempting to save tokens to database');
    console.log('Tokens:', JSON.stringify(tokens, null, 2));

    const client = await connectToMongoDB();
    const db = client.db(DB_NAME);
    const collection = db.collection(COLLECTION_NAME);
    
    await collection.updateOne(
      { _id: TOKEN_ID },
      { $set: { 
        tokenData: tokens, 
        updatedAt: new Date() 
      } },
      { upsert: true }
    );
    
    console.log('Tokens saved successfully to database');
  } catch (error) {
    console.error('Error saving tokens to database:', error);
  }
}

// Express App
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cors({
  origin: ['https://hoachau.de', 'http://localhost:3000'],
  credentials: true
}));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '../')));

// Spotify API credentials
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI;
const FRONTEND_URI = process.env.FRONTEND_URI;

// Spotify API endpoints
const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';

// Helper function to generate random string
function generateRandomString(length) {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(crypto.randomBytes(length))
    .map((x) => possible[x % possible.length])
    .join('');
}

// Helper function to get new access token using refresh token
async function refreshAccessToken() {
  if (!tokenData || !tokenData.refresh_token) {
    console.error('No refresh token available');
    return null;
  }

  try {
    console.log('Attempting to refresh access token');
    const response = await axios.post(
      SPOTIFY_TOKEN_URL,
      querystring.stringify({
        grant_type: 'refresh_token',
        refresh_token: tokenData.refresh_token,
        client_id: CLIENT_ID
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`
        }
      }
    );

    // Update tokens in memory and database
    const newTokens = {
      access_token: response.data.access_token,
      // Keep the existing refresh token if not provided in the response
      refresh_token: response.data.refresh_token || tokenData.refresh_token,
      expires_at: Date.now() + (response.data.expires_in * 1000)
    };

    tokenData = newTokens;
    await saveTokenToDB(newTokens);

    console.log('Access token refreshed successfully');
    return newTokens.access_token;
  } catch (error) {
    console.error('Error refreshing access token:', error.response ? error.response.data : error.message);
    return null;
  }
}

// Middleware to handle token refresh for Spotify API routes
async function spotifyAuthMiddleware(req, res, next) {
  // If no tokens exist, require authentication
  if (!tokenData || !tokenData.refresh_token) {
    return res.status(401).json({ error: 'Authentication required', requireLogin: true });
  }

  // Check if access token is expired or about to expire
  if (!tokenData.expires_at || Date.now() >= tokenData.expires_at - 60000) {
    try {
      const newAccessToken = await refreshAccessToken();
      if (!newAccessToken) {
        return res.status(401).json({ error: 'Failed to refresh token', requireLogin: true });
      }
    } catch (error) {
      return res.status(401).json({ error: 'Authentication failed', requireLogin: true });
    }
  }

  next();
}

// On server startup, load existing tokens
(async () => {
  try {
    tokenData = await loadTokenFromDB();
    if (tokenData) {
      console.log('Tokens loaded on startup');
      console.log('Refresh token:', tokenData.refresh_token ? 'present' : 'missing');
    } else {
      console.log('No tokens found in database');
    }
  } catch (error) {
    console.error('Error during startup token loading:', error);
  }
})();

// Login route
app.get('/login', (req, res) => {
  const state = generateRandomString(16);
  res.cookie('spotify_auth_state', state);

  const scope = [
    'user-read-recently-played',
    'user-top-read',
    'user-read-currently-playing'
  ].join(' ');

  const queryParams = querystring.stringify({
    response_type: 'code',
    client_id: CLIENT_ID,
    scope: scope,
    redirect_uri: REDIRECT_URI,
    state: state,
    show_dialog: true  // Always show login dialog
  });

  res.redirect(`${SPOTIFY_AUTH_URL}?${queryParams}`);
});

// Callback route
app.get('/callback', async (req, res) => {
  const code = req.query.code || null;
  const state = req.query.state || null;
  const storedState = req.cookies ? req.cookies.spotify_auth_state : null;

  if (state === null || state !== storedState) {
    return res.redirect(`${FRONTEND_URI}?error=state_mismatch`);
  }

  res.clearCookie('spotify_auth_state');

  try {
    const response = await axios.post(
      SPOTIFY_TOKEN_URL,
      querystring.stringify({
        code: code,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code'
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`
        }
      }
    );

    // Store all token information
    const newTokens = {
      access_token: response.data.access_token,
      refresh_token: response.data.refresh_token,
      expires_at: Date.now() + (response.data.expires_in * 1000)
    };

    tokenData = newTokens;
    await saveTokenToDB(newTokens);
    
    res.redirect(`${FRONTEND_URI}?success=true`);
  } catch (error) {
    console.error('Token exchange error:', error.response ? error.response.data : error.message);
    res.redirect(`${FRONTEND_URI}?error=token_exchange_failed`);
  }
});

// Spotify API Routes with authentication middleware
app.get('/api/spotify/status', async (req, res) => {
  res.json({
    authenticated: !!tokenData,
    hasRefreshToken: !!(tokenData && tokenData.refresh_token)
  });
});

app.get('/api/spotify/recent', spotifyAuthMiddleware, async (req, res) => {
  try {
    const response = await axios.get(`${SPOTIFY_API_BASE}/me/player/recently-played?limit=10`, {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
    });
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching recent tracks:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: 'Failed to fetch recent tracks' });
  }
});

app.get('/api/spotify/top-tracks', spotifyAuthMiddleware, async (req, res) => {
  const timeRange = req.query.time_range || 'medium_term';
  
  try {
    const response = await axios.get(`${SPOTIFY_API_BASE}/me/top/tracks?limit=10&time_range=${timeRange}`, {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
    });
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching top tracks:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: 'Failed to fetch top tracks' });
  }
});

app.get('/api/spotify/now-playing', spotifyAuthMiddleware, async (req, res) => {
  try {
    const response = await axios.get(`${SPOTIFY_API_BASE}/me/player/currently-playing`, {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
    });
    
    res.json(response.data.is_playing ? {
      isPlaying: true,
      track: response.data.item
    } : { isPlaying: false });
  } catch (error) {
    console.error('Error fetching now playing:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: 'Failed to fetch currently playing track' });
  }
});

// Catch-all route - MUST be last
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../index.html'));
});

// Start the server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

// Close MongoDB connection on server exit
process.on('SIGINT', async () => {
  if (mongoClient) {
    console.log('Closing MongoDB connection');
    await mongoClient.close();
  }
  process.exit(0);
});
