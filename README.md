# 🌦️ Global Weather Dashboard

A modern, responsive weather dashboard built with **Python, Flask, JavaScript, HTML, and CSS**. Search for locations around the world and view current weather conditions, forecasts, air quality information, and saved locations.

## ✨ Features

- 🌍 **Global Location Search** — Search for cities and locations worldwide.
- 🌡️ **Current Weather** — View current temperature and weather conditions.
- 🕒 **Hourly Forecast** — Check upcoming hourly weather.
- 📅 **Daily Forecast** — View the weather forecast for upcoming days.
- 🌫️ **Air Quality Information** — Display air-quality data and pollutant levels when available.
- 📍 **Coordinate Search** — Find weather using latitude and longitude.
- ⭐ **Favorites** — Save frequently searched locations.
- 🕘 **Search History** — Review previous weather searches.
- 📥 **CSV Export** — Export supported weather history data.
- 🌓 **Theme Toggle** — Switch between light and dark modes.
- 📱 **Responsive Interface** — Designed for desktop and mobile screens.
- 🗺️ **Weather Map** — Explore locations on an interactive map, if enabled in the interface.

## 🛠️ Technologies Used

- **Backend:** Python, Flask
- **Frontend:** HTML5, CSS3, JavaScript
- **Database:** SQLite
- **Weather Data:** Open-Meteo API
- **Location Search:** Open-Meteo Geocoding API, with Nominatim fallback where configured
- **Deployment:** Gunicorn, Render
- **Version Control:** Git and GitHub

## 📂 Project Structure

```text
global-weather-dashboard/
├── app.py
├── requirements.txt
├── README.md
├── .gitignore
├── templates/
│   └── index.html
├── static/
│   ├── script.js
│   └── style.css
└── weather_history.db  # Created locally; excluded from Git
```

## ⚙️ Installation and Setup

### 1. Clone the repository

```bash
git clone https://github.com/parvathalasiva/global-weather-dashboard.git
cd global-weather-dashboard
```

### 2. Create a virtual environment

**Windows:**

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
```

**macOS/Linux:**

```bash
python3 -m venv .venv
source .venv/bin/activate
```

### 3. Install dependencies

```bash
pip install -r requirements.txt
```

Ensure `requirements.txt` includes the packages required by the application, such as:

```text
Flask
requests
gunicorn
```

### 4. Run the application

```bash
python app.py
```

Open your browser at:

```text
http://127.0.0.1:5000
```

## 🔌 API Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/` | GET | Open the dashboard |
| `/api/health` | GET | Check application health |
| `/api/search` | GET | Search for locations |
| `/api/weather` | GET | Retrieve weather data |
| `/api/history` | GET | Retrieve search history |
| `/api/export` | GET | Export supported data |
| `/api/favorites` | GET | Retrieve saved locations |
| `/api/favorites` | POST | Add a favorite |
| `/api/favorites` | DELETE | Remove a favorite |

## 🌐 Data Sources

- [Open-Meteo Weather API](https://open-meteo.com/)
- [Open-Meteo Geocoding API](https://open-meteo.com/en/docs/geocoding-api)
- [Open-Meteo Air Quality API](https://open-meteo.com/en/docs/air-quality-api)
- [Nominatim](https://nominatim.org/) for location lookup where configured

Weather and air-quality availability depends on the selected location and the upstream data sources.

## 🚀 Deployment on Render

1. Push the project to GitHub.
2. Open [Render](https://dashboard.render.com/).
3. Create a new **Web Service** and connect this repository.
4. Set the build command:

   ```bash
   pip install -r requirements.txt
   ```

5. Set the start command:

   ```bash
   gunicorn app:app
   ```

6. Deploy and open the public URL provided by Render.

**Note:** SQLite data on a standard ephemeral hosting filesystem may be lost after restarts or redeployments. Use persistent storage or a managed database if your application needs durable history and favorites.

## 🔒 Security and Best Practices

- Keep virtual environments and local database files out of Git.
- Never commit passwords, API keys, or other secrets.
- Validate and handle API responses and user input.
- Use persistent database storage for production data.

## 👨‍💻 Author

**Parvathala Siva Kumar Reddy**

GitHub: [@parvathalasiva](https://github.com/parvathalasiva)

---

If you find this project useful, consider giving the repository a ⭐ on GitHub.
