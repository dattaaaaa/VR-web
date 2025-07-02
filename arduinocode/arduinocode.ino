/*
 * Arduino Motor Controller with Adafruit Motor Shield - REAL-TIME VERSION
 * Receives commands from ESP8266 and controls motors with immediate response
 * Fixes: Command queuing, emergency stop delays, real-time control
 */

#include <AFMotor.h>

// Initialize motors on M1 to M4 using AFMotor library
AF_DCMotor motor1(1);  // M1 - Left Front
AF_DCMotor motor2(2);  // M2 - Right Front  
AF_DCMotor motor3(3);  // M3 - Left Rear
AF_DCMotor motor4(4);  // M4 - Right Rear

// Motor control structure
struct MotorGroup {
  int state; // -1: backward, 0: stop, 1: forward
  int speed; // 0-255 PWM value
};

MotorGroup leftMotors, rightMotors;
String currentCommand = "STOP";
String lastExecutedCommand = "STOP";
unsigned long lastCommandTime = 0;
unsigned long lastStatusReport = 0;
unsigned long lastCommandExecution = 0;
const unsigned long COMMAND_TIMEOUT = 2000; // Reduced to 2 seconds for safety
const unsigned long STATUS_INTERVAL = 1000; // More frequent status reports
const unsigned long COMMAND_DEBOUNCE = 100; // Minimum time between same commands

// Emergency stop flag
volatile bool emergencyStopRequested = false;

// Built-in LED for status
const int STATUS_LED = 13;

// Command buffer for handling rapid commands
String pendingCommand = "";
int pendingG1 = 0;
int pendingG2 = 0;
bool newCommandAvailable = false;

void setup() {
  Serial.begin(9600);
  
  Serial.println("🚀 Arduino REAL-TIME Motor Controller Starting...");
  
  // Initialize status LED
  pinMode(STATUS_LED, OUTPUT);
  digitalWrite(STATUS_LED, LOW);
  
  // Initialize motor states
  leftMotors.state = 0;
  leftMotors.speed = 200;
  rightMotors.state = 0;
  rightMotors.speed = 200;
  
  // Stop all motors initially
  emergencyStop();
  
  Serial.println("🧪 Quick motor test...");
  delay(1000);
  
  // Quick test instead of full test for faster startup
  quickMotorTest();
  
  Serial.println("✅ Arduino REAL-TIME Controller ready!");
  Serial.println("Ready for ESP commands - REAL-TIME MODE ACTIVE");
}

void loop() {
  // PRIORITY 1: Handle emergency stops immediately
  if (emergencyStopRequested) {
    handleEmergencyStop();
  }
  
  // PRIORITY 2: Check for new commands (non-blocking)
  checkSerialCommands();
  
  // PRIORITY 3: Execute pending commands immediately
  if (newCommandAvailable) {
    executeBufferedCommand();
  }
  
  // PRIORITY 4: Safety timeout check
  checkCommandTimeout();
  
  // PRIORITY 5: Send status (less frequent)
  sendStatusReport();
  
  // PRIORITY 6: Update status LED
  updateStatusLED();
  
  // Minimal delay for real-time response
  delay(10);
}

void checkSerialCommands() {
  // Process multiple commands if available to clear buffer faster
  int commandsProcessed = 0;
  
  while (Serial.available() && commandsProcessed < 3) { // Process up to 3 commands per loop
    String command = Serial.readStringUntil('\n');
    command.trim();
    
    if (command.length() > 0) {
      // Check for emergency stop first
      if (isEmergencyStop(command)) {
        emergencyStopRequested = true;
        return; // Exit immediately for emergency stop
      }
      
      // Process normal commands
      if (command.indexOf("{") >= 0 && command.indexOf("}") >= 0) {
        processJsonCommand(command);
      } else {
        handleSimpleCommands(command);
      }
      
      commandsProcessed++;
    }
  }
  
  // Clear any remaining buffer if it's getting too full
  if (Serial.available() > 50) {
    Serial.println("⚠ Clearing command buffer - too many queued commands");
    while (Serial.available()) {
      Serial.read();
    }
  }
}

bool isEmergencyStop(String command) {
  command.toUpperCase();
  return (command.indexOf("STOP") >= 0 || 
          command.indexOf("EMERGENCY") >= 0 || 
          command.indexOf("\"cmd\":\"STOP\"") >= 0 ||
          command == "S");
}

void handleEmergencyStop() {
  Serial.println("🚨 EMERGENCY STOP ACTIVATED");
  
  // Immediately stop all motors
  motor1.run(RELEASE);
  motor2.run(RELEASE);
  motor3.run(RELEASE);
  motor4.run(RELEASE);
  
  // Clear all states
  leftMotors.state = 0;
  rightMotors.state = 0;
  currentCommand = "EMERGENCY_STOP";
  lastExecutedCommand = "EMERGENCY_STOP";
  
  // Clear any pending commands
  newCommandAvailable = false;
  pendingCommand = "";
  
  // Clear serial buffer
  while (Serial.available()) {
    Serial.read();
  }
  
  Serial.println("🛑 ALL MOTORS STOPPED - EMERGENCY");
  Serial.println("ACK: EMERGENCY_STOP");
  
  emergencyStopRequested = false;
  lastCommandTime = millis();
  lastCommandExecution = millis();
}

void processJsonCommand(String jsonCommand) {
  String command = "";
  int group1 = 0;
  int group2 = 0;
  
  if (parseCommand(jsonCommand, command, group1, group2)) {
    // Buffer the command instead of executing immediately
    bufferCommand(command, group1, group2);
    lastCommandTime = millis();
  } else {
    Serial.println("❌ Failed to parse JSON command");
  }
}

void bufferCommand(String command, int g1, int g2) {
  // Skip duplicate commands that are too frequent (debouncing)
  if (command == lastExecutedCommand && 
      (millis() - lastCommandExecution) < COMMAND_DEBOUNCE) {
    return; // Ignore rapid duplicate commands
  }
  
  // Always accept STOP commands immediately
  if (command == "STOP") {
    emergencyStopRequested = true;
    return;
  }
  
  // Buffer the latest command (overwrites previous pending command for real-time response)
  pendingCommand = command;
  pendingG1 = g1;
  pendingG2 = g2;
  newCommandAvailable = true;
}

void executeBufferedCommand() {
  if (!newCommandAvailable) return;
  
  executeCommand(pendingCommand, pendingG1, pendingG2, 200);
  
  // Clear the buffer
  newCommandAvailable = false;
  lastCommandExecution = millis();
  
  Serial.println("ACK: " + pendingCommand);
}

void handleSimpleCommands(String cmd) {
  cmd.toUpperCase();
  
  if (cmd == "STOP" || cmd == "S" || cmd == "EMERGENCY") {
    emergencyStopRequested = true;
    return;
  }
  
  // Buffer other simple commands
  if (cmd == "FORWARD" || cmd == "F") {
    bufferCommand("FORWARD", 1, 1);
  }
  else if (cmd == "BACKWARD" || cmd == "B") {
    bufferCommand("BACKWARD", -1, -1);
  }
  else if (cmd == "LEFT" || cmd == "L") {
    bufferCommand("LEFT", -1, 1);
  }
  else if (cmd == "RIGHT" || cmd == "R") {
    bufferCommand("RIGHT", 1, -1);
  }
  else if (cmd == "TEST") {
    quickMotorTest();
  }
  
  lastCommandTime = millis();
}

bool parseCommand(String json, String &command, int &group1, int &group2) {
  // Extract cmd
  int start = json.indexOf("\"cmd\":\"") + 7;
  int end = json.indexOf("\"", start);
  if (start < 7 || end < 0) return false;
  
  command = json.substring(start, end);
  
  // Extract g1
  start = json.indexOf("\"g1\":") + 5;
  if (start < 5) return false;
  group1 = json.substring(start).toInt();
  
  // Extract g2
  start = json.indexOf("\"g2\":") + 5;
  if (start < 5) return false;
  group2 = json.substring(start).toInt();
  
  return true;
}

void executeCommand(String command, int leftState, int rightState, int speed) {
  currentCommand = command;
  lastExecutedCommand = command;
  leftMotors.state = leftState;
  rightMotors.state = rightState;
  leftMotors.speed = speed;
  rightMotors.speed = speed;
  
  // Control motors using AFMotor library
  controlLeftMotors(leftState, speed);
  controlRightMotors(rightState, speed);
}

void controlLeftMotors(int state, int speed) {
  // Always set speed before running - crucial for AFMotor
  if (speed > 0) {
    motor1.setSpeed(speed);
    motor3.setSpeed(speed);
  }
  
  switch (state) {
    case 1: // Forward
      motor1.run(FORWARD);
      motor3.run(FORWARD);
      break;
      
    case -1: // Backward
      motor1.run(BACKWARD);
      motor3.run(BACKWARD);
      break;
      
    case 0: // Stop
    default:
      motor1.run(RELEASE);
      motor3.run(RELEASE);
      break;
  }
}

void controlRightMotors(int state, int speed) {
  // Always set speed before running - crucial for AFMotor
  if (speed > 0) {
    motor2.setSpeed(speed);
    motor4.setSpeed(speed);
  }
  
  switch (state) {
    case 1: // Forward
      motor2.run(FORWARD);
      motor4.run(FORWARD);
      break;
      
    case -1: // Backward
      motor2.run(BACKWARD);
      motor4.run(BACKWARD);
      break;
      
    case 0: // Stop
    default:
      motor2.run(RELEASE);
      motor4.run(RELEASE);
      break;
  }
}

void quickMotorTest() {
  Serial.println("🧪 Quick motor verification...");
  
  // Quick test all motors forward
  motor1.setSpeed(150);
  motor2.setSpeed(150);
  motor3.setSpeed(150);
  motor4.setSpeed(150);
  
  motor1.run(FORWARD);
  motor2.run(FORWARD);
  motor3.run(FORWARD);
  motor4.run(FORWARD);
  
  delay(500);
  
  motor1.run(RELEASE);
  motor2.run(RELEASE);
  motor3.run(RELEASE);
  motor4.run(RELEASE);
  
  Serial.println("✅ Quick test complete");
}

void emergencyStop() {
  Serial.println("🛑 Emergency stop - all motors off");
  motor1.run(RELEASE);
  motor2.run(RELEASE);
  motor3.run(RELEASE);
  motor4.run(RELEASE);
  leftMotors.state = 0;
  rightMotors.state = 0;
  currentCommand = "STOP";
  lastExecutedCommand = "STOP";
}

void checkCommandTimeout() {
  // Safety: stop motors if no command received for too long
  if (millis() - lastCommandTime > COMMAND_TIMEOUT && currentCommand != "STOP") {
    Serial.println("⚠ Command timeout - stopping motors for safety");
    emergencyStopRequested = true;
  }
}

void sendStatusReport() {
  if (millis() - lastStatusReport > STATUS_INTERVAL) {
    String status = "STATUS: " + currentCommand + 
                   " L:" + String(leftMotors.state) + 
                   " R:" + String(rightMotors.state) + 
                   " Speed:" + String(leftMotors.speed) +
                   " Buffer:" + String(Serial.available());
    
    Serial.println(status);
    
    lastStatusReport = millis();
  }
}

void updateStatusLED() {
  static unsigned long lastBlink = 0;
  static bool ledState = false;
  
  // Fast blink when active, slow when stopped
  unsigned long blinkInterval = (currentCommand == "STOP") ? 1000 : 200;
  
  if (millis() - lastBlink > blinkInterval) {
    ledState = !ledState;
    digitalWrite(STATUS_LED, ledState);
    lastBlink = millis();
  }
}