
"use strict";

/* =========================================================
   WEATHERWORLD — COMPLETE FRONTEND
   Compatible with app.py and templates/index.html
   ========================================================= */

const $ = (id) => document.getElementById(id);

const API = {
    health: "/api/health",
    providerHealth: "/api/provider-health",
    search: "/api/search",
    weather: "/api/weather",
    favorites: "/api/favorites",
    history: "/api/history",
    export: "/api/export"
};

const DEFAULT_LOCATION = {
    name: "Kadapa",
    country: "India",
    latitude: 14.46795,
    longitude: 78.82346,
    timezone: "Asia/Kolkata"
};

const WEATHER_CODES = {
    0: ["Clear sky", "☀️"],
    1: ["Mainly clear", "🌤️"],
    2: ["Partly cloudy", "⛅"],
    3: ["Overcast", "☁️"],
    45: ["Fog", "🌫️"],
    48: ["Depositing rime fog", "🌫️"],
    51: ["Light drizzle", "🌦️"],
    53: ["Moderate drizzle", "🌦️"],
    55: ["Dense drizzle", "🌧️"],
    56: ["Light freezing drizzle", "🌧️"],
    57: ["Dense freezing drizzle", "🌧️"],
    61: ["Slight rain", "🌦️"],
    63: ["Moderate rain", "🌧️"],
    65: ["Heavy rain", "🌧️"],
    66: ["Light freezing rain", "🌧️"],
    67: ["Heavy freezing rain", "🌧️"],
    71: ["Slight snowfall", "🌨️"],
    73: ["Moderate snowfall", "🌨️"],
    75: ["Heavy snowfall", "❄️"],
    77: ["Snow grains", "🌨️"],
    80: ["Slight rain showers", "🌦️"],
    81: ["Moderate rain showers", "🌧️"],
    82: ["Violent rain showers", "⛈️"],
    85: ["Slight snow showers", "🌨️"],
    86: ["Heavy snow showers", "❄️"],
    95: ["Thunderstorm", "⛈️"],
    96: ["Thunderstorm with hail", "⛈️"],
    99: ["Thunderstorm with heavy hail", "⛈️"]
};

const state = {
    location: { ...DEFAULT_LOCATION },
    weatherData: null,
    useFahrenheit: false,
    darkMode: false,
    favorites: [],
    history: [],
    map: null,
    mapMarker: null,
    searchTimer: null,
    searchRequestId: 0,
    weatherRequestId: 0,
    searchAbortController: null,
    weatherAbortController: null,
    lastSearchResults: []
};

/* =========================================================
   GENERAL HELPERS
   ========================================================= */

function finiteNumber(value) {
    if (value === null || value === undefined || value === "") {
        return null;
    }

    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function numberText(value, decimals = 0) {
    const number = finiteNumber(value);
    if (number === null) return "—";

    return number.toLocaleString(undefined, {
        maximumFractionDigits: decimals
    });
}

function setText(id, value) {
    const element = $(id);
    if (element) element.textContent = value;
}

function showElement(element) {
    if (element) element.classList.remove("hidden");
}

function hideElement(element) {
    if (element) element.classList.add("hidden");
}

function showLoading(show) {
    const overlay = $("loadingOverlay");
    if (!overlay) return;

    overlay.classList.toggle("hidden", !show);
}

function showError(message) {
    const error = $("errorBanner");

    if (error) {
        error.textContent = message;
        showElement(error);
    }

    hideElement($("successBanner"));
}

function showSuccess(message) {
    const success = $("successBanner");

    if (success) {
        success.textContent = message;
        showElement(success);
    }

    hideElement($("errorBanner"));
}

function clearMessages() {
    hideElement($("errorBanner"));
    hideElement($("successBanner"));
}

function setStatus(online, message) {
    setText("topStatusText", message);

    const dot = $("topStatusDot");
    if (dot) {
        dot.classList.toggle("online", online);
        dot.classList.toggle("offline", !online);
    }
}

function setProviderStatus(online, message) {
    setText("providerStatusText", message);

    const dot = $("providerStatusDot");
    if (dot) {
        dot.classList.toggle("online", online);
        dot.classList.toggle("offline", !online);
    }
}

async function apiFetch(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: {
            ...(options.body ? { "Content-Type": "application/json" } : {}),
            ...(options.headers || {})
        }
    });

    let data;

    try {
        data = await response.json();
    } catch {
        throw new Error(`The server returned an invalid response (${response.status}).`);
    }

    if (!response.ok) {
        throw new Error(data.error || `Request failed (${response.status}).`);
    }

    return data;
}

function makeQuery(location) {
    const params = new URLSearchParams({
        name: location.name || "Selected location",
        country: location.country || "",
        latitude: String(location.latitude),
        longitude: String(location.longitude),
        timezone: location.timezone || "auto"
    });

    return params.toString();
}

function localLocationName(location) {
    return [location.name, location.admin1, location.country]
        .filter(Boolean)
        .filter((value, index, array) => array.indexOf(value) === index)
        .join(", ");
}

function weatherCodeInfo(code) {
    return WEATHER_CODES[Number(code)] || ["Unknown conditions", "🌡️"];
}

function temperatureValue(value) {
    const number = finiteNumber(value);
    if (number === null) return "—°";

    const result = state.useFahrenheit
        ? (number * 9 / 5) + 32
        : number;

    return `${Math.round(result)}°`;
}

function windSpeedValue(value) {
    const number = finiteNumber(value);
    if (number === null) return "—";

    const speed = state.useFahrenheit
        ? number / 1.609344
        : number;

    return `${numberText(speed, 1)} ${state.useFahrenheit ? "mph" : "km/h"}`;
}

function degreesToDirection(degrees) {
    const number = finiteNumber(degrees);
    if (number === null) return "—";

    const directions = [
        "N", "NNE", "NE", "ENE",
        "E", "ESE", "SE", "SSE",
        "S", "SSW", "SW", "WSW",
        "W", "WNW", "NW", "NNW"
    ];

    return directions[Math.round(number / 22.5) % 16];
}

function formatTime(value, timezone) {
    if (!value) return "—";

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        const match = String(value).match(/T(\d{2}:\d{2})/);
        return match ? match[1] : String(value);
    }

    try {
        return new Intl.DateTimeFormat([], {
            hour: "numeric",
            minute: "2-digit",
            timeZone: timezone && timezone !== "auto" ? timezone : undefined
        }).format(date);
    } catch {
        return date.toLocaleTimeString([], {
            hour: "numeric",
            minute: "2-digit"
        });
    }
}

function formatDateTime(value) {
    if (!value) return "—";

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);

    return date.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
    });
}

function formatForecastDay(value, timezone) {
    if (!value) return "—";

    const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);

    if (match) {
        const date = new Date(Date.UTC(
            Number(match[1]),
            Number(match[2]) - 1,
            Number(match[3]),
            12
        ));

        return new Intl.DateTimeFormat([], {
            weekday: "short",
            month: "short",
            day: "numeric",
            timeZone: "UTC"
        }).format(date);
    }

    return String(value);
}

function sameCoordinates(first, second) {
    if (!first || !second) return false;

    return (
        Math.abs(Number(first.latitude) - Number(second.latitude)) < 0.00001 &&
        Math.abs(Number(first.longitude) - Number(second.longitude)) < 0.00001
    );
}

/* =========================================================
   CURRENT WEATHER AND UV INDEX
   ========================================================= */

function findCurrentUV(current, hourly) {
    const currentUV = finiteNumber(current?.uv_index);
    if (currentUV !== null) return currentUV;

    const values = hourly?.uv_index;
    const times = hourly?.time;

    if (!Array.isArray(values) || !values.length) return null;

    const currentTime = current?.time;

    if (currentTime && Array.isArray(times) && times.length === values.length) {
        const target = new Date(currentTime).getTime();

        if (Number.isFinite(target)) {
            let closestIndex = -1;
            let closestDistance = Infinity;

            times.forEach((time, index) => {
                const timeValue = new Date(time).getTime();
                if (!Number.isFinite(timeValue)) return;

                const distance = Math.abs(timeValue - target);

                if (distance < closestDistance) {
                    closestDistance = distance;
                    closestIndex = index;
                }
            });

            // Do not use a distant hourly value as the current UV.
            if (closestIndex >= 0 && closestDistance <= 90 * 60 * 1000) {
                return finiteNumber(values[closestIndex]);
            }
        }
    }

    return null;
}

function renderCurrent(current, daily) {
    const weather = current || {};
    const [description, icon] = weatherCodeInfo(weather.weather_code);

    setText("locationLabel", localLocationName(state.location));
    setText("currentTemperature", temperatureValue(weather.temperature_2m));
    setText("currentDescription", weather.description || description);

    const apparent = finiteNumber(weather.apparent_temperature);
    setText(
        "feelsLike",
        apparent === null ? "—" : temperatureValue(apparent)
    );

    const iconElement = $("currentIcon");

    if (iconElement) {
        iconElement.textContent = weather.icon || icon;
        iconElement.setAttribute("aria-label", weather.description || description);
    }

    setText(
        "humidity",
        weather.relative_humidity_2m == null
            ? "—"
            : `${numberText(weather.relative_humidity_2m)}%`
    );

    setText("windSpeed", windSpeedValue(weather.wind_speed_10m));
    setText("windDirection", degreesToDirection(weather.wind_direction_10m));

    setText(
        "pressure",
        weather.pressure_msl == null
            ? "—"
            : `${numberText(weather.pressure_msl)} hPa`
    );

    setText(
        "cloudCover",
        weather.cloud_cover == null
            ? "—"
            : `${numberText(weather.cloud_cover)}%`
    );

    setText(
        "precipitation",
        weather.precipitation == null
            ? "—"
            : `${numberText(weather.precipitation, 1)} mm`
    );

    const high = daily?.temperature_2m_max?.[0];
    const low = daily?.temperature_2m_min?.[0];

    setText("todayHigh", high == null ? "—" : temperatureValue(high));
    setText("todayLow", low == null ? "—" : temperatureValue(low));

    const uv = findCurrentUV(weather, state.weatherData?.hourly);
    setText("uvIndex", uv === null ? "—" : numberText(uv, 1));

    setText(
        "sunrise",
        daily?.sunrise?.[0]
            ? formatTime(daily.sunrise[0], state.location.timezone)
            : "—"
    );

    setText(
        "sunset",
        daily?.sunset?.[0]
            ? formatTime(daily.sunset[0], state.location.timezone)
            : "—"
    );

    setText(
        "currentLocalTime",
        weather.time
            ? `Local time: ${formatTime(weather.time, state.location.timezone)}`
            : "Local weather conditions"
    );

    setText(
        "updatedAt",
        state.weatherData?.updated_at
            ? `Updated ${formatDateTime(state.weatherData.updated_at)} · ${state.weatherData.source || "Weather provider"}`
            : "Weather data loaded"
    );

    updateTemperatureUnitLabels();
}

function updateTemperatureUnitLabels() {
    document.querySelectorAll(".degree").forEach((element) => {
        element.textContent = state.useFahrenheit ? "°F" : "°C";
    });

    const button = $("unitToggle");
    if (button) {
        button.textContent = state.useFahrenheit
            ? "Switch to °C"
            : "Switch to °F";
    }
}

/* =========================================================
   HOURLY FORECAST
   ========================================================= */

function renderHourly(hourly) {
    const container = $("hourlyForecast");
    if (!container) return;

    const times = hourly?.time || [];
    const temperatures = hourly?.temperature_2m || [];
    const codes = hourly?.weather_code || [];
    const rainProbabilities = hourly?.precipitation_probability || [];

    if (!times.length || !temperatures.length) {
        container.innerHTML =
            '<div class="placeholder-card">Hourly forecast is unavailable for this location.</div>';
        return;
    }

    const currentTime = state.weatherData?.current?.time;
    let startIndex = 0;

    if (currentTime) {
        const currentStamp = new Date(currentTime).getTime();

        if (Number.isFinite(currentStamp)) {
            const index = times.findIndex((time) => {
                const stamp = new Date(time).getTime();
                return Number.isFinite(stamp) && stamp >= currentStamp;
            });

            if (index >= 0) startIndex = index;
        }
    }

    const fragment = document.createDocumentFragment();

    times.slice(startIndex, startIndex + 24).forEach((time, offset) => {
        const index = startIndex + offset;
        const [description, icon] = weatherCodeInfo(codes[index]);

        const card = document.createElement("article");
        card.className = "hourly-card";

        const timeText = document.createElement("p");
        timeText.className = "forecast-time";
        timeText.textContent = offset === 0
            ? "Now"
            : formatTime(time, state.location.timezone);

        const weatherIcon = document.createElement("div");
        weatherIcon.className = "forecast-icon";
        weatherIcon.textContent = icon;
        weatherIcon.setAttribute("title", description);

        const temperature = document.createElement("strong");
        temperature.className = "forecast-temperature";
        temperature.textContent = temperatureValue(temperatures[index]);

        const rain = document.createElement("p");
        rain.className = "forecast-rain";
        const chance = rainProbabilities[index];
        rain.textContent = chance == null
            ? "Rain —"
            : `Rain ${numberText(chance)}%`;

        card.append(timeText, weatherIcon, temperature, rain);
        fragment.appendChild(card);
    });

    container.replaceChildren(fragment);
}

/* =========================================================
   SEVEN-DAY FORECAST
   ========================================================= */

function renderDaily(daily) {
    const container = $("dailyForecast");
    if (!container) return;

    const times = daily?.time || [];
    const codes = daily?.weather_code || [];
    const highs = daily?.temperature_2m_max || [];
    const lows = daily?.temperature_2m_min || [];
    const rain = daily?.precipitation_probability_max || [];
    const uvValues = daily?.uv_index_max || [];

    if (!times.length) {
        container.innerHTML =
            '<div class="placeholder-card">The daily forecast is unavailable.</div>';
        return;
    }

    const fragment = document.createDocumentFragment();

    times.forEach((date, index) => {
        const [description, icon] = weatherCodeInfo(codes[index]);

        const row = document.createElement("article");
        row.className = "daily-row";

        const day = document.createElement("span");
        day.className = "daily-day";
        day.textContent = index === 0
            ? "Today"
            : formatForecastDay(date, state.location.timezone);

        const weatherIcon = document.createElement("span");
        weatherIcon.className = "daily-icon";
        weatherIcon.textContent = icon;
        weatherIcon.title = description;

        const condition = document.createElement("span");
        condition.className = "daily-description";
        condition.textContent = description;

        const temperature = document.createElement("span");
        temperature.className = "daily-temperature";
        temperature.textContent =
            `${temperatureValue(lows[index])} / ${temperatureValue(highs[index])}`;

        const details = document.createElement("span");
        details.className = "daily-details";

        const rainText = rain[index] == null
            ? "Rain —"
            : `Rain ${numberText(rain[index])}%`;

        const uvText = uvValues[index] == null
            ? "UV —"
            : `UV ${numberText(uvValues[index], 1)}`;

        details.textContent = `${rainText} · ${uvText}`;

        row.append(day, weatherIcon, condition, temperature, details);
        fragment.appendChild(row);
    });

    container.replaceChildren(fragment);
}

/* =========================================================
   AIR QUALITY
   ========================================================= */

function aqiCategory(value, type) {
    const aqi = finiteNumber(value);
    if (aqi === null) {
        return {
            title: "Air quality unavailable",
            description: "Air-quality data is not currently available.",
            className: "unavailable"
        };
    }

    // European AQI has a different scale from US AQI.
    if (type === "european") {
        if (aqi <= 20) {
            return {
                title: "Good",
                description: "Air pollution poses little or no immediate concern.",
                className: "good"
            };
        }
        if (aqi <= 40) {
            return {
                title: "Fair",
                description: "Air quality is generally acceptable.",
                className: "moderate"
            };
        }
        if (aqi <= 60) {
            return {
                title: "Moderate",
                description: "Sensitive people may wish to reduce prolonged outdoor exertion.",
                className: "sensitive"
            };
        }
        if (aqi <= 80) {
            return {
                title: "Poor",
                description: "Consider reducing prolonged outdoor exertion.",
                className: "unhealthy"
            };
        }
        return {
            title: "Very poor",
            description: "Reduce outdoor exertion and follow local health guidance.",
            className: "very-unhealthy"
        };
    }

    if (aqi <= 50) {
        return {
            title: "Good",
            description: "Air quality is satisfactory.",
            className: "good"
        };
    }
    if (aqi <= 100) {
        return {
            title: "Moderate",
            description: "Unusually sensitive people may be affected.",
            className: "moderate"
        };
    }
    if (aqi <= 150) {
        return {
            title: "Unhealthy for sensitive groups",
            description: "Sensitive groups should limit prolonged outdoor exertion.",
            className: "sensitive"
        };
    }
    if (aqi <= 200) {
        return {
            title: "Unhealthy",
            description: "Some people may experience health effects.",
            className: "unhealthy"
        };
    }
    if (aqi <= 300) {
        return {
            title: "Very unhealthy",
            description: "Health alert: reduce outdoor exposure.",
            className: "very-unhealthy"
        };
    }

    return {
        title: "Hazardous",
        description: "Avoid outdoor exertion and follow official local guidance.",
        className: "very-unhealthy"
    };
}

function renderAirQuality(air) {
    if (!air) {
        setText("aqiNumber", "—");
        setText("aqiTitle", "Air quality unavailable");
        setText("aqiDescription", "The air-quality provider did not return readings.");

        const badge = $("aqiBadge");
        if (badge) {
            badge.textContent = "Unavailable";
            badge.className = "aqi-badge unavailable";
        }

        [
            "pm25", "pm10", "co", "no2", "so2", "o3"
        ].forEach((id) => setText(id, "—"));

        return;
    }

    // Prefer US AQI where available. Otherwise label the European scale correctly.
    const usAqi = finiteNumber(air.us_aqi);
    const europeanAqi = finiteNumber(air.european_aqi);
    const usingEuropean = usAqi === null && europeanAqi !== null;
    const selectedAqi = usAqi !== null ? usAqi : europeanAqi;

    const category = aqiCategory(
        selectedAqi,
        usingEuropean ? "european" : "us"
    );

    setText("aqiNumber", selectedAqi === null ? "—" : numberText(selectedAqi));
    setText("aqiTitle", category.title);
    setText(
        "aqiDescription",
        selectedAqi === null
            ? "No AQI value was returned by the provider."
            : `${category.description}${usingEuropean ? " European AQI scale." : " US AQI scale."}`
    );

    const badge = $("aqiBadge");
    if (badge) {
        badge.textContent = selectedAqi === null
            ? "Unavailable"
            : category.title;
        badge.className = `aqi-badge ${category.className}`;
    }

    const circle = document.querySelector(".aqi-circle");
    if (circle) {
        circle.classList.remove(
            "good", "moderate", "sensitive", "unhealthy",
            "very-unhealthy", "unavailable"
        );
        circle.classList.add(category.className);
    }

    const pollutants = [
        ["pm25", air.pm2_5],
        ["pm10", air.pm10],
        ["co", air.carbon_monoxide],
        ["no2", air.nitrogen_dioxide],
        ["so2", air.sulphur_dioxide],
        ["o3", air.ozone]
    ];

    pollutants.forEach(([id, value]) => {
        setText(id, value == null ? "—" : numberText(value, 2));
    });
}

/* =========================================================
   RENDER ALL WEATHER DATA
   ========================================================= */

function renderWeather(data) {
    if (!data || !data.current || !data.location) {
        showError("The weather service returned incomplete weather data.");
        return;
    }

    state.weatherData = data;
    state.location = {
        ...state.location,
        ...data.location
    };

    renderCurrent(data.current, data.daily || {});
    renderHourly(data.hourly || {});
    renderDaily(data.daily || {});
    renderAirQuality(data.air_quality);

    updateFavoriteButton();
    updateMapLocation();

    document.title = `${state.location.name || "Weather"} | WeatherWorld`;
}

/* =========================================================
   LOAD WEATHER
   ========================================================= */

async function loadWeather(location, options = {}) {
    if (!location) return;

    const latitude = finiteNumber(location.latitude);
    const longitude = finiteNumber(location.longitude);

    if (
        latitude === null ||
        longitude === null ||
        latitude < -90 ||
        latitude > 90 ||
        longitude < -180 ||
        longitude > 180
    ) {
        showError("Please select valid latitude and longitude coordinates.");
        return;
    }

    const requestId = ++state.weatherRequestId;

    if (state.weatherAbortController) {
        state.weatherAbortController.abort();
    }

    state.weatherAbortController = new AbortController();

    state.location = {
        name: location.name || "Selected location",
        country: location.country || "",
        admin1: location.admin1 || "",
        latitude,
        longitude,
        timezone: location.timezone || "auto"
    };

    clearMessages();
    setStatus(true, "Loading weather");

    if (!options.silent) showLoading(true);

    try {
        const query = makeQuery(state.location);

        const data = await apiFetch(
            `${API.weather}?${query}`,
            { signal: state.weatherAbortController.signal }
        );

        if (requestId !== state.weatherRequestId) return;

        renderWeather(data);
        setStatus(true, "Weather updated");

        if (!options.silent) {
            showSuccess(`Weather loaded for ${localLocationName(state.location)}.`);
        }

        await Promise.allSettled([
            loadFavorites(),
            loadHistory()
        ]);
    } catch (error) {
        if (requestId !== state.weatherRequestId) return;
        if (error.name === "AbortError") return;

        setStatus(false, "Weather unavailable");
        showError(error.message || "Unable to load weather.");
        console.error("Weather loading error:", error);
    } finally {
        if (requestId === state.weatherRequestId) {
            showLoading(false);
        }
    }
}

/* =========================================================
   CITY SEARCH AND AUTOCOMPLETE
   ========================================================= */

function hideSearchResults() {
    hideElement($("searchResults"));
}

function renderSearchResults(results) {
    const container = $("searchResults");
    if (!container) return;

    state.lastSearchResults = Array.isArray(results) ? results : [];
    container.replaceChildren();

    if (!state.lastSearchResults.length) {
        const empty = document.createElement("div");
        empty.className = "search-empty";
        empty.textContent = "No locations found. Try adding a country name.";
        container.appendChild(empty);
        showElement(container);
        return;
    }

    state.lastSearchResults.forEach((location, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "search-result";
        button.setAttribute("role", "option");
        button.dataset.searchIndex = String(index);

        const title = document.createElement("strong");
        title.textContent = location.name || "Unknown location";

        const subtitle = document.createElement("span");
        subtitle.textContent = [
            location.admin1,
            location.country
        ].filter(Boolean).join(", ");

        button.append(title, subtitle);
        container.appendChild(button);
    });

    showElement(container);
}

async function searchLocations(query) {
    const trimmed = query.trim();
    const requestId = ++state.searchRequestId;

    if (trimmed.length < 2) {
        hideSearchResults();
        return [];
    }

    if (state.searchAbortController) {
        state.searchAbortController.abort();
    }

    state.searchAbortController = new AbortController();

    try {
        const params = new URLSearchParams({ q: trimmed });
        const data = await apiFetch(
            `${API.search}?${params}`,
            { signal: state.searchAbortController.signal }
        );

        if (requestId !== state.searchRequestId) return [];

        renderSearchResults(data.results || []);
        return data.results || [];
    } catch (error) {
        if (error.name !== "AbortError") {
            console.error("Location search error:", error);
        }
        return [];
    }
}

async function submitSearch(query) {
    const trimmed = query.trim();

    if (!trimmed) {
        showError("Enter a city, town, village, or country.");
        return;
    }

    const results = await searchLocations(trimmed);

    if (!results.length) {
        showError("No matching locations found. Try including the country.");
        return;
    }

    // If the search has one result, select it immediately.
    if (results.length === 1) {
        hideSearchResults();
        await loadWeather(results[0]);
        return;
    }

    // For multiple matches, let the user choose the intended location.
    showSuccess("Select the correct location from the suggestions.");
}

function selectSearchResult(index) {
    const location = state.lastSearchResults[index];
    if (!location) return;

    hideSearchResults();

    if ($("locationInput")) {
        $("locationInput").value = localLocationName(location);
    }

    loadWeather(location);
}

/* =========================================================
   FAVORITES
   ========================================================= */

function updateFavoriteButton() {
    const button = $("favoriteToggle");
    if (!button) return;

    const saved = state.favorites.some((item) =>
        sameCoordinates(item, state.location)
    );

    button.textContent = saved ? "★" : "＋";
    button.title = saved ? "Location saved" : "Save current location";
    button.setAttribute(
        "aria-label",
        saved ? "Current location is saved" : "Save current location"
    );
}

function renderFavorites() {
    const container = $("favoritesList");
    if (!container) return;

    container.replaceChildren();

    if (!state.favorites.length) {
        const empty = document.createElement("p");
        empty.className = "muted small-text";
        empty.textContent = "Your saved locations will appear here.";
        container.appendChild(empty);
        updateFavoriteButton();
        return;
    }

    state.favorites.forEach((favorite) => {
        const row = document.createElement("div");
        row.className = "sidebar-item";

        const select = document.createElement("button");
        select.type = "button";
        select.className = "sidebar-item-button";
        select.dataset.favoriteId = String(favorite.id);
        select.textContent = localLocationName(favorite);

        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "icon-button small";
        remove.dataset.removeFavorite = String(favorite.id);
        remove.textContent = "×";
        remove.title = "Remove favorite";
        remove.setAttribute("aria-label", `Remove ${favorite.name}`);

        row.append(select, remove);
        container.appendChild(row);
    });

    updateFavoriteButton();
}

async function loadFavorites() {
    try {
        const data = await apiFetch(API.favorites);
        state.favorites = Array.isArray(data.results) ? data.results : [];
        renderFavorites();
    } catch (error) {
        console.error("Could not load favorites:", error);
    }
}

async function toggleFavorite() {
    const existing = state.favorites.find((item) =>
        sameCoordinates(item, state.location)
    );

    try {
        if (existing) {
            await apiFetch(
                `${API.favorites}/${encodeURIComponent(existing.id)}`,
                { method: "DELETE" }
            );
            showSuccess("Location removed from favorites.");
        } else {
            await apiFetch(API.favorites, {
                method: "POST",
                body: JSON.stringify(state.location)
            });
            showSuccess("Location added to favorites.");
        }

        await loadFavorites();
    } catch (error) {
        showError(error.message || "Could not update favorites.");
    }
}

async function removeFavorite(id) {
    try {
        await apiFetch(
            `${API.favorites}/${encodeURIComponent(id)}`,
            { method: "DELETE" }
        );

        await loadFavorites();
        showSuccess("Favorite removed.");
    } catch (error) {
        showError(error.message || "Could not remove favorite.");
    }
}

/* =========================================================
   RECENT SEARCH HISTORY
   ========================================================= */

function renderHistory() {
    const container = $("historyList");
    if (!container) return;

    container.replaceChildren();

    if (!state.history.length) {
        const empty = document.createElement("p");
        empty.className = "muted small-text";
        empty.textContent = "Your recent searches will appear here.";
        container.appendChild(empty);
        return;
    }

    state.history.forEach((item) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "history-item";
        button.dataset.historyId = String(item.id);

        const name = document.createElement("span");
        name.textContent = localLocationName(item);

        const time = document.createElement("small");
        time.textContent = formatDateTime(item.searched_at);

        button.append(name, time);
        container.appendChild(button);
    });
}

async function loadHistory() {
    try {
        const data = await apiFetch(API.history);
        state.history = Array.isArray(data.results) ? data.results : [];
        renderHistory();
    } catch (error) {
        console.error("Could not load search history:", error);
    }
}

/* =========================================================
   TEMPERATURE UNITS AND THEME
   ========================================================= */

function toggleUnits() {
    state.useFahrenheit = !state.useFahrenheit;

    updateTemperatureUnitLabels();

    if (state.weatherData) {
        renderCurrent(
            state.weatherData.current,
            state.weatherData.daily || {}
        );
        renderHourly(state.weatherData.hourly || {});
        renderDaily(state.weatherData.daily || {});
    }
}

function applyTheme() {
    document.body.classList.toggle("dark-mode", state.darkMode);
    document.documentElement.dataset.theme = state.darkMode ? "dark" : "light";

    const button = $("themeToggle");
    if (button) {
        button.textContent = state.darkMode ? "☀" : "☾";
        button.setAttribute(
            "aria-label",
            state.darkMode ? "Switch to light mode" : "Switch to dark mode"
        );
        button.title = state.darkMode ? "Switch to light mode" : "Switch to dark mode";
    }

    if (state.map) {
        window.setTimeout(() => state.map.invalidateSize(), 100);
    }
}

function toggleTheme() {
    state.darkMode = !state.darkMode;
    applyTheme();
}

/* =========================================================
   GEOLOCATION AND COORDINATE SEARCH
   ========================================================= */

function useBrowserLocation() {
    if (!navigator.geolocation) {
        showError("Geolocation is not supported by this browser.");
        return;
    }

    clearMessages();
    showLoading(true);

    navigator.geolocation.getCurrentPosition(
        async (position) => {
            showLoading(false);

            await loadWeather({
                name: "My location",
                country: "",
                latitude: position.coords.latitude,
                longitude: position.coords.longitude,
                timezone: "auto"
            });
        },
        (error) => {
            showLoading(false);

            const messages = {
                1: "Location access was denied. Allow it in your browser settings.",
                2: "Your current location could not be determined.",
                3: "Location request timed out. Please try again."
            };

            showError(messages[error.code] || "Could not access your location.");
        },
        {
            enableHighAccuracy: false,
            timeout: 12000,
            maximumAge: 300000
        }
    );
}

function searchCoordinates() {
    const raw = window.prompt(
        "Enter latitude and longitude separated by a comma.\nExample: 14.46795, 78.82346"
    );

    if (raw === null) return;

    const parts = raw.split(",").map((part) => part.trim());

    if (parts.length !== 2) {
        showError("Enter coordinates as latitude, longitude.");
        return;
    }

    const latitude = finiteNumber(parts[0]);
    const longitude = finiteNumber(parts[1]);

    if (
        latitude === null ||
        longitude === null ||
        latitude < -90 ||
        latitude > 90 ||
        longitude < -180 ||
        longitude > 180
    ) {
        showError("Coordinates are invalid. Latitude must be −90 to 90 and longitude −180 to 180.");
        return;
    }

    loadWeather({
        name: "Selected coordinates",
        country: "",
        latitude,
        longitude,
        timezone: "auto"
    });
}

/* =========================================================
   LEAFLET WEATHER MAP
   ========================================================= */

function initializeMap() {
    const container = $("weatherMap");

    if (!container) return;

    if (typeof L === "undefined") {
        container.textContent =
            "The map library could not load. Check your internet connection.";
        return;
    }

    try {
        state.map = L.map(container).setView(
            [state.location.latitude, state.location.longitude],
            7
        );

        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
            maxZoom: 19
        }).addTo(state.map);

        state.mapMarker = L.marker([
            state.location.latitude,
            state.location.longitude
        ]).addTo(state.map);

        state.mapMarker.bindPopup(
            localLocationName(state.location)
        );

        state.map.on("click", (event) => {
            const latitude = Number(event.latlng.lat.toFixed(5));
            const longitude = Number(event.latlng.lng.toFixed(5));

            loadWeather({
                name: "Map selection",
                country: "",
                latitude,
                longitude,
                timezone: "auto"
            });
        });

        window.setTimeout(() => {
            state.map?.invalidateSize();
        }, 300);
    } catch (error) {
        console.error("Map initialization error:", error);
        container.textContent = "Could not initialize the map.";
    }
}

function updateMapLocation() {
    if (!state.map || !state.mapMarker) return;

    const position = [
        Number(state.location.latitude),
        Number(state.location.longitude)
    ];

    state.mapMarker.setLatLng(position);
    state.mapMarker.setPopupContent(localLocationName(state.location));

    state.map.setView(position, Math.max(state.map.getZoom(), 7));

    window.setTimeout(() => state.map?.invalidateSize(), 100);
}

/* =========================================================
   SERVICE HEALTH
   ========================================================= */

async function checkProviderHealth() {
    try {
        const result = await apiFetch(API.providerHealth);
        const online = result.status === "online";

        setProviderStatus(
            online,
            online ? "Weather service online" : "Weather service offline"
        );
    } catch (error) {
        setProviderStatus(false, "Weather service unavailable");
        console.error("Provider health check failed:", error);
    }
}

/* =========================================================
   EVENT LISTENERS
   ========================================================= */

function attachEvents() {
    const searchForm = $("searchForm");
    const input = $("locationInput");
    const results = $("searchResults");

    searchForm?.addEventListener("submit", async (event) => {
        event.preventDefault();
        hideSearchResults();
        await submitSearch(input?.value || "");
    });

    input?.addEventListener("input", () => {
        window.clearTimeout(state.searchTimer);

        const query = input.value.trim();

        if (query.length < 2) {
            hideSearchResults();
            return;
        }

        state.searchTimer = window.setTimeout(() => {
            searchLocations(query);
        }, 300);
    });

    results?.addEventListener("click", (event) => {
        const button = event.target.closest("[data-search-index]");
        if (!button) return;

        selectSearchResult(Number(button.dataset.searchIndex));
    });

    input?.addEventListener("keydown", (event) => {
        if (event.key === "Escape") hideSearchResults();

        if (event.key === "ArrowDown") {
            const first = results?.querySelector("button");
            first?.focus();
        }
    });

    document.addEventListener("click", (event) => {
        if (
            results &&
            !results.contains(event.target) &&
            !searchForm?.contains(event.target)
        ) {
            hideSearchResults();
        }
    });

    $("useLocationButton")?.addEventListener("click", useBrowserLocation);
    $("coordinateButton")?.addEventListener("click", searchCoordinates);
    $("favoriteToggle")?.addEventListener("click", toggleFavorite);
    $("unitToggle")?.addEventListener("click", toggleUnits);
    $("themeToggle")?.addEventListener("click", toggleTheme);

    $("favoritesList")?.addEventListener("click", async (event) => {
        const removeButton = event.target.closest("[data-remove-favorite]");

        if (removeButton) {
            await removeFavorite(removeButton.dataset.removeFavorite);
            return;
        }

        const selectButton = event.target.closest("[data-favorite-id]");
        if (!selectButton) return;

        const favorite = state.favorites.find(
            (item) => Number(item.id) === Number(selectButton.dataset.favoriteId)
        );

        if (favorite) await loadWeather(favorite);
    });

    $("historyList")?.addEventListener("click", async (event) => {
        const button = event.target.closest("[data-history-id]");
        if (!button) return;

        const item = state.history.find(
            (entry) => Number(entry.id) === Number(button.dataset.historyId)
        );

        if (item) await loadWeather(item);
    });

    $("refreshHistory")?.addEventListener("click", async () => {
        await loadHistory();
        showSuccess("Search history refreshed.");
    });

    document.querySelectorAll(".nav-link").forEach((link) => {
        link.addEventListener("click", () => {
            document.querySelectorAll(".nav-link").forEach((item) => {
                item.classList.remove("active");
            });

            link.classList.add("active");

            if (link.getAttribute("href") === "#mapSection") {
                window.setTimeout(() => state.map?.invalidateSize(), 150);
            }
        });
    });
}

/* =========================================================
   STARTUP
   ========================================================= */

async function initializeApp() {
    attachEvents();
    applyTheme();
    updateTemperatureUnitLabels();
    initializeMap();

    try {
        const health = await apiFetch(API.health);
        if (health.status === "ok") {
            setStatus(true, "Connected");
        }
    } catch (error) {
        setStatus(false, "Backend unavailable");
        showError("Could not connect to the WeatherWorld backend. Check that Flask is running.");
        console.error("Backend health check failed:", error);
    }

    await checkProviderHealth();

    await Promise.allSettled([
        loadFavorites(),
        loadHistory()
    ]);

    await loadWeather(DEFAULT_LOCATION, { silent: true });

    window.setTimeout(() => {
        state.map?.invalidateSize();
    }, 400);
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeApp, { once: true });
} else {
    initializeApp();
}
