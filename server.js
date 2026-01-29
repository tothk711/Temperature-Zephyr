const express = require('express');
const { Pool } = require('pg');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Cities configuration
const cities = [
  { name: "Prague",   lat: 50.08, lon: 14.42 },
  { name: "Brno",     lat: 49.19, lon: 16.61 },
  { name: "Plzen",    lat: 49.75, lon: 13.38 },
  { name: "Ostrava",  lat: 49.83, lon: 18.29 },
  { name: "Berlin",   lat: 52.52, lon: 13.40 },
  { name: "Munich",   lat: 48.14, lon: 11.58 },
  { name: "Budapest", lat: 47.50, lon: 19.04 },
  { name: "Debrecen", lat: 47.53, lon: 21.63 },
];

// Initialize database
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS weather_data (
      id SERIAL PRIMARY KEY,
      city_name VARCHAR(50) NOT NULL,
      fetch_date DATE NOT NULL,
      target_date DATE NOT NULL,
      hour INTEGER NOT NULL,
      temperature DECIMAL(5,2) NOT NULL,
      is_forecast BOOLEAN NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(city_name, fetch_date, target_date, hour, is_forecast)
    )
  `);
  
  // Index for faster queries
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_weather_city_date 
    ON weather_data(city_name, target_date)
  `);
  
  console.log('Database initialized');
}

// Fetch weather data from Open-Meteo
async function fetchWeatherData(city) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&hourly=temperature_2m&past_days=2&forecast_days=2&timezone=Europe%2FPrague`;
  
  try {
    const response = await fetch(url);
    const data = await response.json();
    return data;
  } catch (error) {
    console.error(`Error fetching weather for ${city.name}:`, error);
    return null;
  }
}

// Store weather data in database
async function storeWeatherData(cityName, weatherData) {
  if (!weatherData || !weatherData.hourly) {
    console.error(`No weather data for ${cityName}`);
    return;
  }

  const fetchDate = new Date().toISOString().split('T')[0];
  const times = weatherData.hourly.time;
  const temps = weatherData.hourly.temperature_2m;

  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];

  for (let i = 0; i < times.length; i++) {
    const timeStr = times[i];
    const temp = temps[i];
    const dateStr = timeStr.split('T')[0];
    const hour = parseInt(timeStr.split('T')[1].split(':')[0]);

    // Determine if this is historical (actual) or forecast data
    // Past dates are actual, future dates are forecasts
    const targetDate = new Date(dateStr);
    const isToday = dateStr === todayStr;
    const isPast = targetDate < today && !isToday;
    const isForecast = !isPast;

    // Only store today and yesterday
    if (dateStr !== todayStr && dateStr !== yesterdayStr) {
      continue;
    }

    try {
      await pool.query(`
        INSERT INTO weather_data (city_name, fetch_date, target_date, hour, temperature, is_forecast)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (city_name, fetch_date, target_date, hour, is_forecast) 
        DO UPDATE SET temperature = $5
      `, [cityName, fetchDate, dateStr, hour, temp, isForecast]);
    } catch (err) {
      console.error(`Error storing data for ${cityName}:`, err.message);
    }
  }

  console.log(`Stored weather data for ${cityName}`);
}

// Fetch and store data for all cities
async function fetchAllCities() {
  console.log('Starting weather data fetch for all cities...');
  
  for (const city of cities) {
    const weatherData = await fetchWeatherData(city);
    await storeWeatherData(city.name, weatherData);
    // Small delay to be nice to the API
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  console.log('Finished fetching weather data for all cities');
}

// Clean up old data (keep only 14 days)
async function cleanupOldData() {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 14);
  
  await pool.query(`
    DELETE FROM weather_data 
    WHERE target_date < $1
  `, [cutoffDate.toISOString().split('T')[0]]);
  
  console.log('Cleaned up old weather data');
}

// Middleware
app.use(express.json());
app.use(express.static('public'));

// API Routes

// Get list of cities
app.get('/api/cities', (req, res) => {
  res.json(cities.map(c => c.name));
});

// Get weather data for a city
app.get('/api/weather/:city', async (req, res) => {
  const cityName = req.params.city;
  
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];

  try {
    // Get actual temperatures (most recent fetch for each date)
    const actualData = await pool.query(`
      SELECT DISTINCT ON (target_date, hour) 
        target_date, hour, temperature
      FROM weather_data
      WHERE city_name = $1 
        AND target_date IN ($2, $3)
        AND is_forecast = false
      ORDER BY target_date, hour, fetch_date DESC
    `, [cityName, todayStr, yesterdayStr]);

    // Get forecast temperatures (predictions made before the target date)
    const forecastData = await pool.query(`
      SELECT DISTINCT ON (target_date, hour)
        target_date, hour, temperature, fetch_date
      FROM weather_data
      WHERE city_name = $1 
        AND target_date IN ($2, $3)
        AND is_forecast = true
        AND fetch_date < target_date
      ORDER BY target_date, hour, fetch_date DESC
    `, [cityName, todayStr, yesterdayStr]);

    // Organize data
    const result = {
      today: todayStr,
      yesterday: yesterdayStr,
      todayActual: Array(24).fill(null),
      yesterdayActual: Array(24).fill(null),
      todayForecast: Array(24).fill(null),
      yesterdayForecast: Array(24).fill(null),
    };

    // Fill in actual data
    for (const row of actualData.rows) {
      const dateStr = row.target_date.toISOString().split('T')[0];
      const hour = row.hour;
      const temp = parseFloat(row.temperature);
      
      if (dateStr === todayStr) {
        result.todayActual[hour] = temp;
      } else if (dateStr === yesterdayStr) {
        result.yesterdayActual[hour] = temp;
      }
    }

    // Fill in forecast data
    for (const row of forecastData.rows) {
      const dateStr = row.target_date.toISOString().split('T')[0];
      const hour = row.hour;
      const temp = parseFloat(row.temperature);
      
      if (dateStr === todayStr) {
        result.todayForecast[hour] = temp;
      } else if (dateStr === yesterdayStr) {
        result.yesterdayForecast[hour] = temp;
      }
    }

    res.json(result);
  } catch (err) {
    console.error('Error fetching weather data:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Manual trigger to fetch data (useful for testing)
app.post('/api/fetch', async (req, res) => {
  try {
    await fetchAllCities();
    await cleanupOldData();
    res.json({ success: true, message: 'Weather data fetched successfully' });
  } catch (err) {
    console.error('Error in manual fetch:', err);
    res.status(500).json({ error: 'Fetch failed' });
  }
});

// Get last fetch time
app.get('/api/status', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT MAX(created_at) as last_fetch 
      FROM weather_data
    `);
    res.json({ 
      lastFetch: result.rows[0]?.last_fetch || null,
      cities: cities.length
    });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Initialize and start
async function start() {
  await initDB();
  
  // Schedule daily fetch at 6:00 AM
  cron.schedule('0 6 * * *', async () => {
    console.log('Running scheduled weather fetch...');
    await fetchAllCities();
    await cleanupOldData();
  });
  
  // Also fetch on startup if database is empty
  const count = await pool.query('SELECT COUNT(*) FROM weather_data');
  if (parseInt(count.rows[0].count) === 0) {
    console.log('Database empty, fetching initial data...');
    await fetchAllCities();
  }
  
  app.listen(PORT, () => {
    console.log(`Weather app running on port ${PORT}`);
  });
}

start().catch(console.error);
