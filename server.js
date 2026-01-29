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

// Initialize database (simple cache table)
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS weather_cache (
      id SERIAL PRIMARY KEY,
      city_name VARCHAR(50) NOT NULL UNIQUE,
      data JSONB NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('Database initialized');
}

// Get date string in YYYY-MM-DD format
function getDateString(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return date.toISOString().split('T')[0];
}

// Fetch weather data from Open-Meteo for a city
async function fetchWeatherFromAPI(city) {
  // Get 3 days of history and 2 days forecast
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&hourly=temperature_2m&past_days=3&forecast_days=2&timezone=Europe%2FPrague`;
  
  try {
    const response = await fetch(url);
    const data = await response.json();
    
    if (!data.hourly) {
      throw new Error('No hourly data in response');
    }

    // Parse the data into our 4 days
    const twoDaysAgo = getDateString(-2);
    const yesterday = getDateString(-1);
    const today = getDateString(0);
    const tomorrow = getDateString(1);

    const result = {
      twoDaysAgo: { date: twoDaysAgo, temps: Array(24).fill(null) },
      yesterday: { date: yesterday, temps: Array(24).fill(null) },
      today: { date: today, temps: Array(24).fill(null) },
      tomorrow: { date: tomorrow, temps: Array(24).fill(null) },
      updatedAt: new Date().toISOString()
    };

    // Fill in temperatures
    const times = data.hourly.time;
    const temps = data.hourly.temperature_2m;

    for (let i = 0; i < times.length; i++) {
      const dateStr = times[i].split('T')[0];
      const hour = parseInt(times[i].split('T')[1].split(':')[0]);
      const temp = temps[i];

      if (dateStr === twoDaysAgo) {
        result.twoDaysAgo.temps[hour] = temp;
      } else if (dateStr === yesterday) {
        result.yesterday.temps[hour] = temp;
      } else if (dateStr === today) {
        result.today.temps[hour] = temp;
      } else if (dateStr === tomorrow) {
        result.tomorrow.temps[hour] = temp;
      }
    }

    return result;
  } catch (error) {
    console.error(`Error fetching weather for ${city.name}:`, error.message);
    return null;
  }
}

// Store weather data in cache
async function cacheWeatherData(cityName, data) {
  try {
    await pool.query(`
      INSERT INTO weather_cache (city_name, data, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (city_name) 
      DO UPDATE SET data = $2, updated_at = NOW()
    `, [cityName, JSON.stringify(data)]);
    console.log(`Cached weather data for ${cityName}`);
  } catch (err) {
    console.error(`Error caching data for ${cityName}:`, err.message);
  }
}

// Get cached weather data
async function getCachedWeather(cityName) {
  try {
    const result = await pool.query(`
      SELECT data, updated_at FROM weather_cache WHERE city_name = $1
    `, [cityName]);
    
    if (result.rows.length > 0) {
      return {
        data: result.rows[0].data,
        updatedAt: result.rows[0].updated_at
      };
    }
    return null;
  } catch (err) {
    console.error(`Error getting cached data for ${cityName}:`, err.message);
    return null;
  }
}

// Fetch and cache data for all cities
async function fetchAllCities() {
  console.log('Starting weather data fetch for all cities...');
  
  for (const city of cities) {
    const data = await fetchWeatherFromAPI(city);
    if (data) {
      await cacheWeatherData(city.name, data);
    }
    // Small delay to be nice to the API
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  console.log('Finished fetching weather data for all cities');
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
  
  // Check if city exists
  const city = cities.find(c => c.name === cityName);
  if (!city) {
    return res.status(404).json({ error: 'City not found' });
  }

  // Try to get cached data first
  let cached = await getCachedWeather(cityName);
  
  // If no cache or cache is older than 1 hour, fetch fresh data
  if (!cached || (Date.now() - new Date(cached.updatedAt).getTime()) > 3600000) {
    console.log(`Fetching fresh data for ${cityName}...`);
    const freshData = await fetchWeatherFromAPI(city);
    if (freshData) {
      await cacheWeatherData(cityName, freshData);
      cached = { data: freshData, updatedAt: new Date() };
    }
  }

  if (cached) {
    res.json(cached.data);
  } else {
    res.status(500).json({ error: 'Could not fetch weather data' });
  }
});

// Manual trigger to fetch data for all cities
app.post('/api/fetch', async (req, res) => {
  try {
    await fetchAllCities();
    res.json({ success: true, message: 'Weather data fetched for all cities' });
  } catch (err) {
    console.error('Error in manual fetch:', err);
    res.status(500).json({ error: 'Fetch failed' });
  }
});

// Get status
app.get('/api/status', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT city_name, updated_at FROM weather_cache ORDER BY city_name
    `);
    res.json({ 
      cities: result.rows,
      totalCities: cities.length
    });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Initialize and start
async function start() {
  await initDB();
  
  // Schedule fetch every 6 hours
  cron.schedule('0 */6 * * *', async () => {
    console.log('Running scheduled weather fetch...');
    await fetchAllCities();
  });
  
  // Fetch on startup
  console.log('Fetching initial weather data...');
  await fetchAllCities();
  
  app.listen(PORT, () => {
    console.log(`Weather app running on port ${PORT}`);
  });
}

start().catch(console.error);
