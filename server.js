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
class MotorController {
    constructor() {
        // Motor pairs: Group1 (1,3,5) and Group2 (2,4,6)
        this.motorStates = {
            group1: 0, // -1: backward, 0: stop, 1: forward
            group2: 0
        };
        this.currentCommand = 'STOP';
    }

    // Convert VR controller input to motor commands
    processControllerInput(leftController, rightController) {
        let command = 'STOP';
        let group1 = 0, group2 = 0;

        // Right thumbstick for movement
        if (rightController.axes && rightController.axes.length >= 2) {
            const x = rightController.axes[0]; // Left/Right
            const y = rightController.axes[1]; // Forward/Backward

            // Deadzone
            if (Math.abs(x) > 0.3 || Math.abs(y) > 0.3) {
                if (Math.abs(y) > Math.abs(x)) {
                    // Forward/Backward movement
                    if (y < -0.3) {
                        command = 'FORWARD';
                        group1 = 1;
                        group2 = 1;
                    } else if (y > 0.3) {
                        command = 'BACKWARD';
                        group1 = -1;
                        group2 = -1;
                    }
                } else {
                    // Left/Right movement
                    if (x < -0.3) {
                        command = 'LEFT';
                        group1 = 1;
                        group2 = -1;
                    } else if (x > 0.3) {
                        command = 'RIGHT';
                        group1 = -1;
                        group2 = 1;
                    }
                }
            }
        }

        // Left thumbstick for rotation
        if (leftController.axes && leftController.axes.length >= 2) {
            const x = leftController.axes[0];
            if (Math.abs(x) > 0.3) {
                if (x < -0.3) {
                    command = 'ROTATE_LEFT';
                    group1 = -1;
                    group2 = 1;
                } else if (x > 0.3) {
                    command = 'ROTATE_RIGHT';
                    group1 = 1;
                    group2 = -1;
                }
            }
        }

        // Trigger for emergency stop
        if (leftController.buttons?.[1]?.pressed || rightController.buttons?.[1]?.pressed) {
            command = 'EMERGENCY_STOP';
            group1 = 0;
            group2 = 0;
        }

        this.motorStates.group1 = group1;
        this.motorStates.group2 = group2;
        this.currentCommand = command;

        return {
            command,
            group1,
            group2,
            motors: this.getMotorStates()
        };
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