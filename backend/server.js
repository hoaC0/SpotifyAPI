// server.js
const express = require('express');
const axios = require('axios');
const querystring = require('querystring');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const { MongoClient } = require('mongodb');
require('dotenv').config();

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://your-username:your-password@cluster0.xxx.mongodb.net/spotifydb?retryWrites=true&w=majority';
const DB_NAME = 'spotifydb';
const COLLECTION_NAME = 'tokens';
const TOKEN_ID = 'main_token'; // Wir verwenden einen festen ID für den Token

let mongoClient = null;
let tokenData = null;

// Funktion zum Verbinden mit MongoDB
async function connectToMongoDB() {
  if (mongoClient) return mongoClient;
  
  try {
    mongoClient = new MongoClient(MONGODB_URI);
    await mongoClient.connect();
    console.log('Connected to MongoDB');
    return mongoClient;
  } catch (error) {
    console.error('Failed to connect to MongoDB:', error);
    throw error;
  }
}

// Funktion zum Laden des Tokens aus der Datenbank
async function loadTokenFromDB() {
  try {
    const client = await connectToMongoDB();
    const db = client.db(DB_NAME);
    const collection = db.collection(COLLECTION_NAME);
    
    const tokenDoc = await collection.findOne({ _id: TOKEN_ID });
    
    if (tokenDoc) {
      console.log('Token from database loaded');
      return tokenDoc.tokenData;
    }
    return null;
  } catch (error) {
    console.error('Error loading token from database:', error);
    return null;
  }
}

// Funktion zum Speichern des Tokens in der Datenbank
async function saveTokenToDB(token) {
  try {
    const client = await connectToMongoDB();
    const db = client.db(DB_NAME);
    const collection = db.collection(COLLECTION_NAME);
    
    await collection.updateOne(
      { _id: TOKEN_ID },
      { $set: { tokenData: token, updatedAt: new Date() } },
      { upsert: true }
    );
    
    console.log('Token saved to database');
  } catch (error) {
    console.error('Error saving token to database:', error);
  }
}

// Express App
const app = express();
const port = process.env.PORT || 3000;

// Add request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

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
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || 'https://spotify-api-iota-one.vercel.app/callback';
const FRONTEND_URI = process.env.FRONTEND_URI || 'https://hoachau.de';

// Spotify API endpoints
const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';

// Beim Serverstart den Token laden
(async () => {
  try {
    tokenData = await loadTokenFromDB();
    if (tokenData) {
      console.log('Token loaded on startup. Expires at:', new Date(tokenData.expires_at).toISOString());
      
      // Überprüfen, ob der Token erneuert werden muss
      if (Date.now() >= tokenData.expires_at - 60000) {
        console.log('Token expired or about to expire. Will refresh on first API call.');
      }
    } else {
      console.log('No token found in database. Waiting for authentication.');
    }
  } catch (error) {
    console.error('Error during startup token loading:', error);
  }
})();

// Login route
app.get('/login', (req, res) => {
  console.log('Login route accessed');
  
  const state = generateRandomString(16);
  console.log('Generated state:', state);
  
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
    state: state
  });

  const authUrl = `${SPOTIFY_AUTH_URL}?${queryParams}`;
  console.log('Redirecting to Spotify auth URL:', authUrl);
  
  res.redirect(authUrl);
});

// Callback route
app.get('/callback', async (req, res) => {
  console.log('Callback route accessed');
  
  const code = req.query.code || null;
  const state = req.query.state || null;
  const storedState = req.cookies ? req.cookies.spotify_auth_state : null;

  console.log('Received code from Spotify:', code ? 'Yes' : 'No');
  console.log('State match:', state === storedState);

  if (state === null || state !== storedState) {
    console.log('State mismatch! Redirecting with error.');
    res.redirect(`${FRONTEND_URI}?error=state_mismatch`);
    return;
  }

  res.clearCookie('spotify_auth_state');

  try {
    console.log('Exchanging code for token...');
    
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

    console.log('Token exchange successful!');

    tokenData = {
      access_token: response.data.access_token,
      refresh_token: response.data.refresh_token,
      expires_in: response.data.expires_in,
      expires_at: Date.now() + (response.data.expires_in * 1000)
    };

    // Token in der Datenbank speichern
    await saveTokenToDB(tokenData);
    
    res.redirect(`${FRONTEND_URI}?success=true`);
  } catch (error) {
    console.error('Error in callback:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
    res.redirect(`${FRONTEND_URI}?error=invalid_token`);
  }
});

// API Routes
// Status endpoint
app.get('/api/spotify/status', async (req, res) => {
  console.log('Status endpoint called');
  
  // Aktuellen Token-Status aus der Datenbank laden
  if (!tokenData) {
    tokenData = await loadTokenFromDB();
  }
  
  res.json({
    authenticated: !!tokenData,
    tokenExpires: tokenData ? new Date(tokenData.expires_at).toISOString() : null,
    timeRemaining: tokenData ? Math.floor((tokenData.expires_at - Date.now()) / 1000) + ' seconds' : null
  });
});

// Route to get recent tracks
app.get('/api/spotify/recent', async (req, res) => {
  console.log('Recent tracks API called');
  
  try {
    // Wenn kein Token im Speicher ist, aus der Datenbank laden
    if (!tokenData) {
      tokenData = await loadTokenFromDB();
    }
    
    await checkAndRefreshToken();
    
    if (!tokenData || !tokenData.access_token) {
      console.log('No token data available. Sending 401.');
      return res.status(401).json({ error: 'Not authenticated with Spotify' });
    }

    console.log('Fetching recently played tracks from Spotify API');
    const response = await axios.get(`${SPOTIFY_API_BASE}/me/player/recently-played?limit=10`, {
      headers: {
        'Authorization': `Bearer ${tokenData.access_token}`
      }
    });

    console.log('Successfully fetched recently played tracks');
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching recent tracks:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
    }
    res.status(500).json({ error: 'Failed to fetch recent tracks' });
  }
});

// Route to get top tracks
app.get('/api/spotify/top-tracks', async (req, res) => {
  const timeRange = req.query.time_range || 'medium_term'; // short_term, medium_term, long_term
  
  console.log('Top tracks API called with time range:', timeRange);
  
  try {
    // Wenn kein Token im Speicher ist, aus der Datenbank laden
    if (!tokenData) {
      tokenData = await loadTokenFromDB();
    }
    
    await checkAndRefreshToken();
    
    if (!tokenData || !tokenData.access_token) {
      console.log('No token data available. Sending 401.');
      return res.status(401).json({ error: 'Not authenticated with Spotify' });
    }

    console.log('Fetching top tracks from Spotify API');
    const response = await axios.get(`${SPOTIFY_API_BASE}/me/top/tracks?limit=10&time_range=${timeRange}`, {
      headers: {
        'Authorization': `Bearer ${tokenData.access_token}`
      }
    });

    console.log('Successfully fetched top tracks');
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching top tracks:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
    }
    res.status(500).json({ error: 'Failed to fetch top tracks' });
  }
});

// Route to get currently playing
app.get('/api/spotify/now-playing', async (req, res) => {
  console.log('Now playing API called');
  
  try {
    // Wenn kein Token im Speicher ist, aus der Datenbank laden
    if (!tokenData) {
      tokenData = await loadTokenFromDB();
    }
    
    await checkAndRefreshToken();
    
    if (!tokenData || !tokenData.access_token) {
      console.log('No token data available. Sending 401.');
      return res.status(401).json({ error: 'Not authenticated with Spotify' });
    }

    console.log('Fetching currently playing track from Spotify API');
    const response = await axios.get(`${SPOTIFY_API_BASE}/me/player/currently-playing`, {
      headers: {
        'Authorization': `Bearer ${tokenData.access_token}`
      }
    });

    // If no track is playing, API returns 204 No Content
    if (response.status === 204) {
      console.log('No track currently playing (204 response)');
      return res.json({ isPlaying: false });
    }

    console.log('Successfully fetched currently playing track');
    res.json({
      isPlaying: response.data.is_playing,
      track: response.data.item
    });
  } catch (error) {
    console.error('Error fetching currently playing:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
    }
    res.status(500).json({ error: 'Failed to fetch currently playing track' });
  }
});

// Helper function to refresh token
async function checkAndRefreshToken() {
  if (!tokenData) {
    console.log('No token data to refresh');
    return;
  }

  const timeLeft = (tokenData.expires_at - Date.now()) / 1000;
  console.log(`Token expires in ${timeLeft.toFixed(2)} seconds`);
  
  // If token is expired or about to expire in the next minute
  if (Date.now() >= tokenData.expires_at - 60000) {
    console.log('Token expired or expiring soon, refreshing...');
    
    try {
      console.log('Using refresh token:', tokenData.refresh_token ? 'present' : 'missing');
      
      const response = await axios.post(
        SPOTIFY_TOKEN_URL,
        querystring.stringify({
          grant_type: 'refresh_token',
          refresh_token: tokenData.refresh_token
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`
          }
        }
      );

      console.log('Token refresh successful!');
      
      tokenData = {
        access_token: response.data.access_token,
        refresh_token: response.data.refresh_token || tokenData.refresh_token,
        expires_in: response.data.expires_in,
        expires_at: Date.now() + (response.data.expires_in * 1000)
      };
      
      console.log('Updated token data, expires at:', new Date(tokenData.expires_at).toISOString());
      
      // Token in der Datenbank aktualisieren
      await saveTokenToDB(tokenData);
    } catch (error) {
      console.error('Error refreshing token:', error.message);
      if (error.response) {
        console.error('Response status:', error.response.status);
      }
      // Token-Daten auf null setzen, damit kein weiterer Zugriff versucht wird
      tokenData = null;
    }
  } else {
    console.log('Token still valid, no refresh needed');
  }
}

// Helper function to generate random string
function generateRandomString(length) {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < length; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

// Catch-all route - MUST be last
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../index.html'));
});

// Starten Sie den Server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

// Verbindung bei Beendigung sauber schließen
process.on('SIGINT', async () => {
  if (mongoClient) {
    console.log('Closing MongoDB connection');
    await mongoClient.close();
  }
  process.exit(0);
});
