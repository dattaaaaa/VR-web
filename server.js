const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mqtt = require('mqtt');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Middleware
app.use(cors());
app.use(express.static('public'));
app.use(express.json());

// MQTT Configuration
const MQTT_CONFIG = {
    host: 'd20951d2e2aa49e98e82561d859007d3.s1.eu.hivemq.cloud',
    port: 8883,
    protocol: 'mqtts',
    username: 'lunar',
    password: 'Rover123',
    clientId: `rover_control_${Math.random().toString(16).substr(2, 8)}`
};

const MQTT_TOPICS = {
    ROVER_CONTROL: 'rover/control',
    ROVER_STATUS: 'rover/status',
    ROVER_MOTORS: 'rover/motors'
};

// Motor Control Logic
// Updated Motor Control Logic for Quest 2 Controllers
class MotorController {
    constructor() {
        // Motor pairs: Group1 (1,3,5) and Group2 (2,4,6)
        this.motorStates = {
            group1: 0, // -1: backward, 0: stop, 1: forward
            group2: 0
        };
        this.currentCommand = 'STOP';
        this.lastCommand = 'STOP';
        this.debugMode = true; // Enable detailed logging
    }

    // Convert VR controller input to motor commands
    processControllerInput(leftController, rightController) {
        let command = 'STOP';
        let group1 = 0, group2 = 0;

        // Debug: Log the complete controller state
        if (this.debugMode) {
            console.log('🔍 Controller Debug Info:');
            console.log('Left Controller Axes:', leftController.axes?.map(a => a?.toFixed(3)) || 'none');
            console.log('Right Controller Axes:', rightController.axes?.map(a => a?.toFixed(3)) || 'none');
            console.log('Left Buttons Pressed:', leftController.buttons?.filter(b => b?.pressed).length || 0);
            console.log('Right Buttons Pressed:', rightController.buttons?.filter(b => b?.pressed).length || 0);
        }

        // Quest 2 Controller Axis Mapping (commonly axes[2] and axes[3] for thumbsticks)
        // Try multiple possible axis configurations
        const rightThumbstick = this.getThumbstickValues(rightController, 'right');
        const leftThumbstick = this.getThumbstickValues(leftController, 'left');

        if (this.debugMode) {
            console.log('🎮 Processed Thumbsticks:');
            console.log('Right Thumbstick:', rightThumbstick);
            console.log('Left Thumbstick:', leftThumbstick);
        }

        const deadzone = 0.2; // Increased deadzone for better control

        // Right thumbstick for movement (Primary movement)
        if (rightThumbstick.x !== 0 || rightThumbstick.y !== 0) {
            if (Math.abs(rightThumbstick.x) > deadzone || Math.abs(rightThumbstick.y) > deadzone) {
                if (Math.abs(rightThumbstick.y) > Math.abs(rightThumbstick.x)) {
                    // Forward/Backward movement (Y-axis)
                    if (rightThumbstick.y < -deadzone) {
                        command = 'FORWARD';
                        group1 = 1;
                        group2 = 1;
                    } else if (rightThumbstick.y > deadzone) {
                        command = 'BACKWARD';
                        group1 = -1;
                        group2 = -1;
                    }
                } else {
                    // Left/Right movement (X-axis)
                    if (rightThumbstick.x < -deadzone) {
                        command = 'LEFT';
                        group1 = 1;   // Left motors forward
                        group2 = -1;  // Right motors backward
                    } else if (rightThumbstick.x > deadzone) {
                        command = 'RIGHT';
                        group1 = -1;  // Left motors backward
                        group2 = 1;   // Right motors forward
                    }
                }
            }
        }

        // Left thumbstick for rotation (Override movement if rotating)
        if (leftThumbstick.x !== 0) {
            if (Math.abs(leftThumbstick.x) > deadzone) {
                if (leftThumbstick.x < -deadzone) {
                    command = 'ROTATE_LEFT';
                    group1 = -1;  // Left motors backward
                    group2 = 1;   // Right motors forward
                } else if (leftThumbstick.x > deadzone) {
                    command = 'ROTATE_RIGHT';
                    group1 = 1;   // Left motors forward
                    group2 = -1;  // Right motors backward
                }
            }
        }

        // Emergency stop with triggers or grip buttons
        if (this.checkEmergencyStop(leftController, rightController)) {
            command = 'EMERGENCY_STOP';
            group1 = 0;
            group2 = 0;
        }

        // Update motor states
        this.motorStates.group1 = group1;
        this.motorStates.group2 = group2;
        
        // Only log if command changed to reduce spam
        if (command !== this.lastCommand) {
            console.log(`🚀 Command Changed: ${this.lastCommand} → ${command}`);
            this.lastCommand = command;
        }
        
        this.currentCommand = command;

        return {
            command,
            group1,
            group2,
            motors: this.getMotorStates(),
            debug: {
                rightThumbstick,
                leftThumbstick,
                deadzone
            }
        };
    }

    // Extract thumbstick values from different possible axis positions
    getThumbstickValues(controller, hand) {
        if (!controller.axes || controller.axes.length === 0) {
            return { x: 0, y: 0 };
        }

        const axes = controller.axes;
        let x = 0, y = 0;

        // Quest 2 controller axis mapping variations
        // Try different common configurations
        if (axes.length >= 4) {
            // Configuration 1: axes[2] and axes[3] (most common for Quest 2)
            if (Math.abs(axes[2]) > 0.05 || Math.abs(axes[3]) > 0.05) {
                x = axes[2] || 0;
                y = axes[3] || 0;
            }
            // Configuration 2: axes[0] and axes[1] (standard)
            else if (Math.abs(axes[0]) > 0.05 || Math.abs(axes[1]) > 0.05) {
                x = axes[0] || 0;
                y = axes[1] || 0;
            }
        } else if (axes.length >= 2) {
            // Fallback to first two axes
            x = axes[0] || 0;
            y = axes[1] || 0;
        }

        // Auto-detect which axes have actual input
        if (x === 0 && y === 0 && axes.length > 0) {
            // Check all axes to find the active ones
            for (let i = 0; i < axes.length - 1; i += 2) {
                if (Math.abs(axes[i]) > 0.05 || Math.abs(axes[i + 1]) > 0.05) {
                    x = axes[i] || 0;
                    y = axes[i + 1] || 0;
                    if (this.debugMode) {
                        console.log(`🔍 Auto-detected thumbstick at axes[${i}], axes[${i + 1}] for ${hand} controller`);
                    }
                    break;
                }
            }
        }

        return { x: parseFloat(x.toFixed(3)), y: parseFloat(y.toFixed(3)) };
    }

    // Check for emergency stop conditions
    checkEmergencyStop(leftController, rightController) {
        // Check various button combinations that might be triggers
        const checkButtons = (controller) => {
            if (!controller.buttons) return false;
            
            // Check common trigger button indices
            const triggerIndices = [0, 1, 2, 6, 7]; // Common trigger button indices
            return triggerIndices.some(i => controller.buttons[i]?.pressed);
        };

        return checkButtons(leftController) || checkButtons(rightController);
    }

    getMotorStates() {
        return {
            motor1: this.motorStates.group1,
            motor2: this.motorStates.group2,
            motor3: this.motorStates.group1,
            motor4: this.motorStates.group2,
            motor5: this.motorStates.group1,
            motor6: this.motorStates.group2
        };
    }

    // Method to disable debug logging once everything is working
    setDebugMode(enabled) {
        this.debugMode = enabled;
    }
}

// Initialize MQTT Client
let mqttClient = null;
const motorController = new MotorController();

function connectToMQTT() {
    console.log('🔌 Connecting to MQTT broker...');
    console.log(`📡 Broker: ${MQTT_CONFIG.host}:${MQTT_CONFIG.port}`);
    
    mqttClient = mqtt.connect(MQTT_CONFIG);

    mqttClient.on('connect', () => {
        console.log('✅ MQTT Connected successfully');
        console.log(`🆔 Client ID: ${MQTT_CONFIG.clientId}`);
        
        // Subscribe to rover status
        mqttClient.subscribe(MQTT_TOPICS.ROVER_STATUS, (err) => {
            if (err) {
                console.error('❌ Failed to subscribe to rover status:', err);
            } else {
                console.log('📬 Subscribed to rover status updates');
            }
        });

        // Send initial status
        publishMotorCommand('STOP', { group1: 0, group2: 0 });
    });

    mqttClient.on('message', (topic, message) => {
        const msg = message.toString();
        console.log(`📨 MQTT Message [${topic}]: ${msg}`);
        
        // Broadcast to all connected VR clients
        io.emit('rover-status', {
            topic,
            message: msg,
            timestamp: new Date().toISOString()
        });
    });

    mqttClient.on('error', (error) => {
        console.error('❌ MQTT Error:', error);
    });

    mqttClient.on('disconnect', () => {
        console.log('🔌 MQTT Disconnected');
    });

    mqttClient.on('reconnect', () => {
        console.log('🔄 MQTT Reconnecting...');
    });
}

function publishMotorCommand(command, motorStates) {
    if (!mqttClient || !mqttClient.connected) {
        console.error('❌ MQTT not connected, cannot send command');
        return;
    }

    const payload = {
        command,
        timestamp: new Date().toISOString(),
        motors: motorStates.motors || motorController.getMotorStates(),
        group1: motorStates.group1 || 0,
        group2: motorStates.group2 || 0
    };

    const message = JSON.stringify(payload);
    
    mqttClient.publish(MQTT_TOPICS.ROVER_CONTROL, message, { qos: 1 }, (err) => {
        if (err) {
            console.error('❌ Failed to publish motor command:', err);
        } else {
            console.log(`🚀 Motor Command Sent: ${command}`);
            console.log(`⚙️  Group1 (1,3,5): ${payload.group1}, Group2 (2,4,6): ${payload.group2}`);
        }
    });
}

// Socket.IO for real-time communication with VR client
io.on('connection', (socket) => {
    console.log('🎮 VR Client connected:', socket.id);

    socket.on('controller-input', (data) => {
        const { leftController, rightController } = data;
        
        // Process controller input
        const motorCommand = motorController.processControllerInput(leftController, rightController);
        
        // Log controller input
        console.log('🕹️  Controller Input:', {
            command: motorCommand.command,
            leftAxes: leftController.axes?.map(a => a.toFixed(2)),
            rightAxes: rightController.axes?.map(a => a.toFixed(2)),
            leftButtons: leftController.buttons?.filter(b => b.pressed).length || 0,
            rightButtons: rightController.buttons?.filter(b => b.pressed).length || 0
        });

        // Send to rover via MQTT
        publishMotorCommand(motorCommand.command, motorCommand);

        // Send feedback to VR client
        socket.emit('motor-feedback', {
            command: motorCommand.command,
            motorStates: motorCommand.motors,
            timestamp: new Date().toISOString()
        });
    });

    socket.on('emergency-stop', () => {
        console.log('🚨 EMERGENCY STOP triggered by VR client');
        publishMotorCommand('EMERGENCY_STOP', { group1: 0, group2: 0 });
    });

    socket.on('disconnect', () => {
        console.log('👋 VR Client disconnected:', socket.id);
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        mqtt: mqttClient?.connected || false,
        timestamp: new Date().toISOString()
    });
});

// API endpoints
app.get('/api/status', (req, res) => {
    res.json({
        server: 'running',
        mqtt: {
            connected: mqttClient?.connected || false,
            broker: MQTT_CONFIG.host
        },
        motors: motorController.getMotorStates(),
        currentCommand: motorController.currentCommand
    });
});

app.post('/api/emergency-stop', (req, res) => {
    console.log('🚨 Emergency stop via API');
    publishMotorCommand('EMERGENCY_STOP', { group1: 0, group2: 0 });
    res.json({ success: true, message: 'Emergency stop executed' });
});

// Serve the VR application
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log('🚀 VR Rover Control Server Started');
    console.log(`🌐 Server running on port ${PORT}`);
    console.log(`🔗 Access at: http://localhost:${PORT}`);
    console.log('🎮 Ready for Meta Quest 2 connection');
    
    // Connect to MQTT
    connectToMQTT();
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down server...');
    
    if (mqttClient) {
        publishMotorCommand('EMERGENCY_STOP', { group1: 0, group2: 0 });
        mqttClient.end();
    }
    
    server.close(() => {
        console.log('👋 Server shut down complete');
        process.exit(0);
    });
});

module.exports = { app, server };