/*
 * ESP8266 MQTT WiFi Controller for Rover - REAL-TIME VERSION
 * Receives MQTT commands and sends to Arduino with intelligent throttling
 * Fixes: Command flooding, emergency stop priority, real-time control
 */

#include <ESP8266WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

// WiFi credentials
const char* ssid = "OnePlus";
const char* password = "12345678";

// MQTT credentials
const char* mqtt_server = "d20951d2e2aa49e98e82561d859007d3.s1.eu.hivemq.cloud";
const int mqtt_port = 8883;
const char* mqtt_user = "lunar";
const char* mqtt_password = "Rover123";
const char* client_id = "esp8266_rover_wifi";

// MQTT topics
const char* topic_control = "rover/control";
const char* topic_status = "rover/status";

WiFiClientSecure espClient;
PubSubClient client(espClient);

// Real-time command handling
String lastCommand = "STOP";
String currentCommand = "STOP";
unsigned long lastCommandTime = 0;
unsigned long lastArduinoResponse = 0;
unsigned long lastHeartbeat = 0;
unsigned long lastCommandSent = 0;

// Timing constants for real-time control
const unsigned long HEARTBEAT_INTERVAL = 3000;
const unsigned long ARDUINO_TIMEOUT = 2000;
const unsigned long COMMAND_THROTTLE = 80; // Minimum time between commands (ms)
const unsigned long STOP_COMMAND_PRIORITY = 20; // STOP commands can be sent every 20ms

// Command state tracking
bool emergencyStopActive = false;
int duplicateCommandCount = 0;
const int MAX_DUPLICATE_COMMANDS = 3; // Skip after 3 identical commands

// Status LED
const int STATUS_LED = 2; // Built-in LED

void setup() {
  // Initialize Serial for Arduino communication
  Serial.begin(9600);
  
  Serial.println("\n🚀 ESP8266 REAL-TIME MQTT Controller Starting...");
  
  // Initialize status LED
  pinMode(STATUS_LED, OUTPUT);
  digitalWrite(STATUS_LED, HIGH); // OFF (inverted logic)
  
  // Connect to WiFi
  connectToWiFi();
  
  // Configure MQTT
  espClient.setInsecure();
  client.setServer(mqtt_server, mqtt_port);
  client.setCallback(mqttCallback);
  
  // Connect to MQTT
  connectToMQTT();
  
  // Test Arduino communication
  testArduinoCommunication();
  
  Serial.println("✅ ESP8266 REAL-TIME Controller ready!");
  Serial.println("📡 Real-time command throttling active");
}

void loop() {
  // Maintain MQTT connection
  if (!client.connected()) {
    connectToMQTT();
  }
  client.loop();
  
  // Check for Arduino responses (priority handling)
  checkArduinoSerial();
  
  // Send periodic heartbeat (less frequent)
  sendHeartbeat();
  
  // Update status LED
  updateStatusLED();
  
  // Minimal delay for maximum responsiveness
  delay(5);
}

void connectToWiFi() {
  Serial.print("🌐 Connecting to WiFi: ");
  Serial.println(ssid);
  
  WiFi.begin(ssid, password);
  
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(500);
    Serial.print(".");
    attempts++;
  }
  
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n✅ WiFi connected!");
    Serial.print("📍 IP address: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\n❌ WiFi connection failed!");
    ESP.restart();
  }
}

void connectToMQTT() {
  while (!client.connected()) {
    Serial.print("📡 Connecting to MQTT broker...");
    
    if (client.connect(client_id, mqtt_user, mqtt_password)) {
      Serial.println(" ✅ Connected!");
      
      // Subscribe to control topic
      client.subscribe(topic_control);
      Serial.println("📬 Subscribed to rover/control");
      
      // Send startup message
      publishStatus("ESP8266 REAL-TIME Controller connected");
      
    } else {
      Serial.print(" ❌ Failed, rc=");
      Serial.print(client.state());
      Serial.println(" Retrying in 3 seconds...");
      delay(3000);
    }
  }
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String message = "";
  for (int i = 0; i < length; i++) {
    message += (char)payload[i];
  }
  
  // Extract command quickly
  String command = "";
  int group1 = 0;
  int group2 = 0;
  
  if (extractCommand(message, command, group1, group2)) {
    handleCommandWithThrottling(command, group1, group2);
  } else {
    Serial.println("❌ Failed to parse MQTT command");
  }
}

bool extractCommand(String json, String &command, int &group1, int &group2) {
  // Extract command
  int start = json.indexOf("\"command\":\"") + 11;
  int end = json.indexOf("\"", start);
  if (start < 11 || end < 0) return false;
  
  command = json.substring(start, end);
  
  // Extract group1
  start = json.indexOf("\"group1\":") + 9;
  if (start < 9) return false;
  group1 = json.substring(start).toInt();
  
  // Extract group2
  start = json.indexOf("\"group2\":") + 9;
  if (start < 9) return false;
  group2 = json.substring(start).toInt();
  
  return true;
}

void handleCommandWithThrottling(String command, int group1, int group2) {
  unsigned long currentTime = millis();
  
  // PRIORITY 1: Emergency STOP commands - always allow with minimal delay
  if (command == "STOP" || command == "EMERGENCY_STOP") {
    if (currentTime - lastCommandSent >= STOP_COMMAND_PRIORITY) {
      forwardCommandToArduino(command, group1, group2);
      emergencyStopActive = true;
      duplicateCommandCount = 0; // Reset counter
      Serial.println("🚨 EMERGENCY STOP - Immediate forward");
      return;
    }
  }
  
  // PRIORITY 2: New different command - always allow
  if (command != lastCommand) {
    forwardCommandToArduino(command, group1, group2);
    duplicateCommandCount = 0; // Reset counter
    emergencyStopActive = false;
    return;
  }
  
  // PRIORITY 3: Throttle duplicate commands
  if (currentTime - lastCommandSent >= COMMAND_THROTTLE) {
    // Allow some duplicates for continuous movement, but limit flooding
    if (duplicateCommandCount < MAX_DUPLICATE_COMMANDS) {
      forwardCommandToArduino(command, group1, group2);
      duplicateCommandCount++;
    } else {
      // Skip this duplicate command to prevent flooding
      Serial.println("⚡ Throttling duplicate command: " + command);
    }
  }
  
  // Reset duplicate counter after some time of no commands
  if (currentTime - lastCommandTime > 500) {
    duplicateCommandCount = 0;
  }
}

void forwardCommandToArduino(String command, int group1, int group2) {
  String arduinoCommand = "{\"cmd\":\"" + command + "\",\"g1\":" + group1 + ",\"g2\":" + group2 + "}";
  
  Serial.println(arduinoCommand);
  
  // Update tracking variables
  lastCommand = command;
  currentCommand = command;
  lastCommandTime = millis();
  lastCommandSent = millis();
  
  // Send minimal acknowledgment to MQTT (don't flood)
  if (command == "STOP" || millis() - lastHeartbeat > 1000) {
    publishStatus("CMD: " + command);
  }
}

void checkArduinoSerial() {
  // Process multiple Arduino responses to clear buffer
  int responsesProcessed = 0;
  
  while (Serial.available() && responsesProcessed < 5) {
    String response = Serial.readStringUntil('\n');
    response.trim();
    
    if (response.length() > 0) {
      lastArduinoResponse = millis();
      
      // Only forward important Arduino messages to MQTT
      if (response.indexOf("EMERGENCY") >= 0 || 
          response.indexOf("ERROR") >= 0 || 
          response.indexOf("ACK") >= 0) {
        publishStatus("Arduino: " + response);
      }
      
      responsesProcessed++;
    }
  }
}

void testArduinoCommunication() {
  Serial.println("🧪 Testing Arduino communication...");
  
  Serial.println("{\"cmd\":\"TEST\",\"g1\":0,\"g2\":0}");
  
  // Wait for response
  unsigned long startTime = millis();
  while (millis() - startTime < 1500) {
    if (Serial.available()) {
      String response = Serial.readStringUntil('\n');
      Serial.println("✅ Arduino responded: " + response);
      return;
    }
    delay(50);
  }
  
  Serial.println("⚠ No response from Arduino - check connections!");
}

void sendHeartbeat() {
  if (millis() - lastHeartbeat > HEARTBEAT_INTERVAL) {
    DynamicJsonDocument doc(256);
    doc["status"] = "ESP8266 Real-time Controller";
    doc["last_command"] = currentCommand;
    doc["wifi_rssi"] = WiFi.RSSI();
    doc["arduino_ok"] = (millis() - lastArduinoResponse < ARDUINO_TIMEOUT);
    doc["emergency_stop"] = emergencyStopActive;
    doc["duplicate_count"] = duplicateCommandCount;
    
    String payload;
    serializeJson(doc, payload);
    
    client.publish(topic_status, payload.c_str());
    
    lastHeartbeat = millis();
  }
}

void publishStatus(String message) {
  if (client.connected()) {
    DynamicJsonDocument doc(256);
    doc["status"] = message;
    doc["timestamp"] = millis();
    
    String payload;
    serializeJson(doc, payload);
    
    client.publish(topic_status, payload.c_str());
  }
}

void updateStatusLED() {
  static unsigned long lastBlink = 0;
  static bool ledState = false;
  
  if (client.connected() && (millis() - lastArduinoResponse < ARDUINO_TIMEOUT)) {
    // Different blink patterns based on activity
    unsigned long interval = emergencyStopActive ? 100 : 1000; // Fast blink for emergency
    
    if (millis() - lastBlink > interval) {
      ledState = !ledState;
      digitalWrite(STATUS_LED, ledState ? LOW : HIGH);
      lastBlink = millis();
    }
  } else {
    // Rapid blink when there's an issue
    if (millis() - lastBlink > 200) {
      ledState = !ledState;
      digitalWrite(STATUS_LED, ledState ? LOW : HIGH);
      lastBlink = millis();
    }
  }
}