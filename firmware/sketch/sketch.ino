// --- Pin Assignments ---
#define DHTPIN 2          // DHT11 Data Pin
#define FORK_PIN A0       // Soil Moisture Sensor (Analog)
#define LDR_PIN A1        // Light Sensor (Analog)
#define FAN_PIN 5         // Aeration Fan / Relay LED
#define BUZZER_PIN 6      // Active Buzzer (I/O)
#define TRIG_PIN 9        // Ultrasonic Trig Pin
#define ECHO_PIN 10       // Ultrasonic Echo Pin
#define STATUS_LED_PIN LED_BUILTIN

void setup() {
  Serial.begin(9600);
  
  pinMode(DHTPIN, INPUT_PULLUP);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  pinMode(FAN_PIN, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(STATUS_LED_PIN, OUTPUT);
  
  digitalWrite(FAN_PIN, LOW);
  digitalWrite(BUZZER_PIN, LOW);
  digitalWrite(STATUS_LED_PIN, LOW);
}

// Robust bit-banged DHT11 reader with zero-freeze timeouts
bool readDHT11(float &temp, float &humidity) {
  byte data[5] = {0, 0, 0, 0, 0};
  
  // 1. Send start signal
  pinMode(DHTPIN, OUTPUT);
  digitalWrite(DHTPIN, LOW);
  delay(18); // 18ms LOW
  digitalWrite(DHTPIN, HIGH);
  delayMicroseconds(30);
  pinMode(DHTPIN, INPUT_PULLUP);
  
  // 2. Wait for DHT response with timeout protection
  unsigned long timeout = micros();
  while (digitalRead(DHTPIN) == HIGH) {
    if (micros() - timeout > 100) return false;
  }
  timeout = micros();
  while (digitalRead(DHTPIN) == LOW) {
    if (micros() - timeout > 100) return false;
  }
  timeout = micros();
  while (digitalRead(DHTPIN) == HIGH) {
    if (micros() - timeout > 100) return false;
  }
  
  // 3. Read 40 data bits with per-bit timeouts
  for (int i = 0; i < 40; i++) {
    timeout = micros();
    while (digitalRead(DHTPIN) == LOW) {
      if (micros() - timeout > 100) return false; // Prevent infinite hang
    }
    
    unsigned long t_high_start = micros();
    while (digitalRead(DHTPIN) == HIGH) {
      if (micros() - t_high_start > 100) return false; // Prevent infinite hang
    }
    
    // DHT11 protocol: HIGH pulse > 40µs indicates bit '1', ~26-28µs indicates bit '0'
    if ((micros() - t_high_start) > 40) {
      data[i / 8] |= (1 << (7 - (i % 8)));
    }
  }
  
  // 4. Verify Checksum
  if (data[4] == ((data[0] + data[1] + data[2] + data[3]) & 0xFF)) {
    humidity = (float)data[0];
    temp = (float)data[2];
    return true;
  }
  
  return false;
}

float getDistance() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  
  long duration = pulseIn(ECHO_PIN, HIGH, 30000); // 30ms timeout (~5m max)
  if (duration == 0) return -1.0; // Invalid reading; never invent a headspace value
  return duration * 0.034 / 2.0;
}

void loop() {
  float current_t = -999.0;
  float current_rh = -999.0;
  const bool dht_valid = readDHT11(current_t, current_rh);
  if (!dht_valid) {
    current_t = -999.0;
    current_rh = -999.0;
  }

  int fork = analogRead(FORK_PIN);
  int ldr = analogRead(LDR_PIN);
  float dist = getDistance();

  // Send the standardized packet expected by serial_worker.py
  // Format: DATA,Temp,RH,Fork,LDR,Distance
  Serial.print("DATA,");
  Serial.print(current_t, 1); Serial.print(",");
  Serial.print(current_rh, 1); Serial.print(",");
  Serial.print(fork); Serial.print(",");
  Serial.print(ldr); Serial.print(",");
  Serial.println(dist, 1);

  // Process incoming commands from Python backend
  if (Serial.available() > 0) {
    char cmd = Serial.read();
    if (cmd == 'F') digitalWrite(FAN_PIN, HIGH);        // Fan ON
    else if (cmd == 'f') digitalWrite(FAN_PIN, LOW);     // Fan OFF
    else if (cmd == 'B') digitalWrite(BUZZER_PIN, HIGH); // Buzzer ON
    else if (cmd == 'b') digitalWrite(BUZZER_PIN, LOW);  // Buzzer OFF
    else if (cmd == 'G') digitalWrite(STATUS_LED_PIN, HIGH); // All checks passed
    else if (cmd == 'g') digitalWrite(STATUS_LED_PIN, LOW);  // Invalid or unsafe
    
    // Clear any extra characters in the buffer
    while (Serial.available() > 0) Serial.read();
  }

  delay(1000); // DHT11-safe 1-second sampling interval
}