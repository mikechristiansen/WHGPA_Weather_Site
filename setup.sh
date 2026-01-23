#!/bin/bash
# Weather Station Docker Setup Script
# Run this script to set up your weather station monitoring system

set -e

echo "=== Weather Station Docker Setup ==="
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    echo "Please run as root (sudo ./setup.sh)"
    exit 1
fi

# Install Docker if not present
if ! command -v docker &> /dev/null; then
    echo "Installing Docker..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sh get-docker.sh
    rm get-docker.sh
    systemctl enable docker
    systemctl start docker
fi

# Install Docker Compose if not present
if ! command -v docker-compose &> /dev/null; then
    echo "Installing Docker Compose..."
    curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
    chmod +x /usr/local/bin/docker-compose
fi

echo ""
echo "Docker and Docker Compose installed successfully!"
echo ""

# Get domain names
read -p "Enter your weather dashboard domain (e.g., weather.yourdomain.com): " WEATHER_DOMAIN
read -p "Enter your MQTT domain (e.g., mqtt.yourdomain.com): " MQTT_DOMAIN
read -p "Enter your email for Let's Encrypt: " EMAIL

# Create directory structure
echo ""
echo "Creating directory structure..."
mkdir -p mosquitto/{config,data,log}
mkdir -p nginx/{conf.d,html}
mkdir -p certbot/{conf,www}

# Update domains in config files
echo "Updating configuration files..."
sed -i "s/mqtt.yourdomain.com/$MQTT_DOMAIN/g" mosquitto/config/mosquitto.conf
sed -i "s/weather.yourdomain.com/$WEATHER_DOMAIN/g" nginx/conf.d/weather.conf

# Create initial mosquitto password file
echo ""
echo "Setting up MQTT users..."
read -p "Enter password for MQTT admin user: " -s ADMIN_PASS
echo ""
read -p "Enter password for MQTT viewer user (for web app): " -s VIEWER_PASS
echo ""

# Create password file using docker
docker run --rm -v $(pwd)/mosquitto/config:/mosquitto/config eclipse-mosquitto:2 \
    mosquitto_passwd -b -c /mosquitto/config/passwd admin "$ADMIN_PASS"
docker run --rm -v $(pwd)/mosquitto/config:/mosquitto/config eclipse-mosquitto:2 \
    mosquitto_passwd -b /mosquitto/config/passwd weatherviewer "$VIEWER_PASS"

# Set permissions
chmod 700 mosquitto/config/passwd
chmod 755 mosquitto/{data,log}

echo ""
echo "=== Getting SSL Certificates ==="
echo ""
echo "Make sure your domains point to this server's IP before continuing!"
read -p "Press Enter when ready to obtain SSL certificates..."

# Get certificate for weather dashboard
docker-compose run --rm certbot certonly --webroot \
    --webroot-path=/var/www/certbot \
    --email $EMAIL \
    --agree-tos \
    --no-eff-email \
    -d $WEATHER_DOMAIN

# Get certificate for MQTT
docker-compose run --rm certbot certonly --webroot \
    --webroot-path=/var/www/certbot \
    --email $EMAIL \
    --agree-tos \
    --no-eff-email \
    -d $MQTT_DOMAIN

echo ""
echo "=== Setup Complete! ==="
echo ""
echo "Next steps:"
echo "1. Copy your built React app to: ./nginx/html/"
echo "2. Update the MQTT config in your React app:"
echo "   - Broker: wss://$MQTT_DOMAIN:8883"
echo "   - Username: weatherviewer"
echo "   - Password: [the password you set]"
echo "3. Configure your weather stations to publish to: mqtt://$MQTT_DOMAIN:1883"
echo "   - Username: admin"
echo "   - Password: [the admin password you set]"
echo "4. Start the services: docker-compose up -d"
echo "5. View logs: docker-compose logs -f"
echo ""
echo "Your weather dashboard will be available at: https://$WEATHER_DOMAIN"
echo ""
