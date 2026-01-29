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
  // Drop old table and create new one with better structure
  await pool.query(`
    CREATE TABLE IF NOT EXISTS weather_data (
      id SERIAL PRIMARY KEY,
      city_name VARCHAR(50) NOT NULL,
      fetch_date DATE NOT NULL,
      target_date DATE NOT NULL,
      hour INTEGER NOT NULL,
      temperature DECIMAL(5,2) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(city_name, fetch_date, target_date, hour)
    )
  `);
  
  // Index for faster queries
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_weather_city_target 
    ON weather_data(city_name, target_date)
  `);
  
  console.log('Database initialized');
}

// Get today's date in YYYY-MM-DD format (in Europe/Prague timezone)
function getLocalDate(offsetDays = 0) {
  const now = new Date();
  // Adjust for Central European Time (UTC+1)
  now.setHours(now.getHours() + 1);
  now.setDate(now.getDate() + offsetDays);
  return now.toISOString().split('T')[0];
}

// Fetch weather data from Open-Meteo
async function fetchWeatherData(city) {
  // Get past 3 days and forecast for next 3 days
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&hourly=temperature_2m&past_days=3&forecast_days=3&timezone=Europe%2FPrague`;
  
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

  const fetchDate = getLocalDate(0); // Today's date as fetch date
  const times = weatherData.hourly.time;
  const temps = weatherData.hourly.temperature_2m;

  let stored = 0;
  for (let i = 0; i < times.length; i++) {
    const timeStr = times[i];
    const temp = temps[i];
    const targetDate = timeStr.split('T')[0];
    const hour = parseInt(timeStr.split('T')[1].split(':')[0]);

    try {
      await pool.query(`
        INSERT INTO weather_data (city_name, fetch_date, target_date, hour, temperature)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (city_name, fetch_date, target_date, hour) 
        DO UPDATE SET temperature = $5
      `, [cityName, fetchDate, targetDate, hour, temp]);
      stored++;
    } catch (err) {
      console.error(`Error storing data for ${cityName}:`, err.message);
    }
  }

  console.log(`Stored ${stored} weather records for ${cityName}`);
}

// Fetch and store data for all cities
async function fetchAllCities() {
  console.log('Starting weather data fetch for all cities...');
  
  for (const city of cities) {
    const weatherData = await fetchWeatherData(city);
    await storeWeatherData(city.name, weatherData);
    // Small delay to be nice to the API
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  console.log('Finished fetching weather data for all cities');
}

// Clean up old data (keep only 14 days)
async function cleanupOldData() {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 14);
  
  const result = await pool.query(`
    DELETE FROM weather_data 
    WHERE fetch_date < $1
  `, [cutoffDate.toISOString().split('T')[0]]);
  
  console.log(`Cleaned up ${result.rowCount} old weather records`);
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
  
  const today = getLocalDate(0);
  const yesterday = getLocalDate(-1);

  try {
    // ACTUAL data: What was recorded ON that day (fetch_date = target_date)
    // This is the "actual" temperature because we fetched it on the same day
    const actualToday = await pool.query(`
      SELECT hour, temperature
      FROM weather_data
      WHERE city_name = $1 
        AND target_date = $2
        AND fetch_date = $2
      ORDER BY hour
    `, [cityName, today]);

    const actualYesterday = await pool.query(`
      SELECT hour, temperature
      FROM weather_data
      WHERE city_name = $1 
        AND target_date = $2
        AND fetch_date = $2
      ORDER BY hour
    `, [cityName, yesterday]);

    // FORECAST data: What was PREDICTED for that day (fetch_date < target_date)
    // Get the earliest prediction we have for each day
    const forecastToday = await pool.query(`
      SELECT DISTINCT ON (hour) hour, temperature, fetch_date
      FROM weather_data
      WHERE city_name = $1 
        AND target_date = $2
        AND fetch_date < $2
      ORDER BY hour, fetch_date ASC
    `, [cityName, today]);

    const forecastYesterday = await pool.query(`
      SELECT DISTINCT ON (hour) hour, temperature, fetch_date
      FROM weather_data
      WHERE city_name = $1 
        AND target_date = $2
        AND fetch_date < $2
      ORDER BY hour, fetch_date ASC
    `, [cityName, yesterday]);

    // Build result arrays (24 hours)
    const result = {
      today: today,
      yesterday: yesterday,
      todayActual: Array(24).fill(null),
      yesterdayActual: Array(24).fill(null),
      todayForecast: Array(24).fill(null),
      yesterdayForecast: Array(24).fill(null),
    };

    // Fill in actual data
    for (const row of actualToday.rows) {
      result.todayActual[row.hour] = parseFloat(row.temperature);
    }
    for (const row of actualYesterday.rows) {
      result.yesterdayActual[row.hour] = parseFloat(row.temperature);
    }

    // Fill in forecast data
    for (const row of forecastToday.rows) {
      result.todayForecast[row.hour] = parseFloat(row.temperature);
    }
    for (const row of forecastYesterday.rows) {
      result.yesterdayForecast[row.hour] = parseFloat(row.temperature);
    }

    res.json(result);
  } catch (err) {
    console.error('Error fetching weather data:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Debug endpoint - see what data we have
app.get('/api/debug/:city', async (req, res) => {
  const cityName = req.params.city;
  
  try {
    const data = await pool.query(`
      SELECT fetch_date, target_date, COUNT(*) as hours, 
             MIN(temperature) as min_temp, MAX(temperature) as max_temp
      FROM weather_data
      WHERE city_name = $1
      GROUP BY fetch_date, target_date
      ORDER BY fetch_date DESC, target_date
    `, [cityName]);
    
    res.json({
      city: cityName,
      today: getLocalDate(0),
      yesterday: getLocalDate(-1),
      records: data.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    const countResult = await pool.query(`
      SELECT COUNT(DISTINCT target_date) as days, COUNT(*) as total_records
      FROM weather_data
    `);
    res.json({ 
      lastFetch: result.rows[0]?.last_fetch || null,
      cities: cities.length,
      daysOfData: countResult.rows[0]?.days || 0,
      totalRecords: countResult.rows[0]?.total_records || 0
    });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Initialize and start
async function start() {
  await initDB();
  
  // Schedule fetch twice daily: 6:00 AM and 6:00 PM
  cron.schedule('0 6,18 * * *', async () => {
    console.log('Running scheduled weather fetch...');
    await fetchAllCities();
    await cleanupOldData();
  });
  
  // Also fetch on startup if database is empty or no data for today
  const today = getLocalDate(0);
  const count = await pool.query(
    'SELECT COUNT(*) FROM weather_data WHERE fetch_date = $1', 
    [today]
  );
  
  if (parseInt(count.rows[0].count) === 0) {
    console.log('No data for today, fetching initial data...');
    await fetchAllCities();
  }
  
  app.listen(PORT, () => {
    console.log(`Weather app running on port ${PORT}`);
  });
}

start().catch(console.error);
