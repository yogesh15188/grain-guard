// GrainGuard firmware for the Wokwi circuit simulation.
// Same pins, same DATA format and same F/f, B/b, G/g serial commands as
// firmware/sketch/sketch.ino. The only change: the DHT reader uses the Adafruit
// library with a DHT22, because Wokwi's simulated humidity/temperature part is a DHT22.
// The physical build keeps the DHT11 bit-banged reader in firmware/sketch/sketch.ino.
#include <DHT.h>

#define DHTPIN 2
#define DHTTYPE DHT22
#define FORK_PIN A0
#define LDR_PIN A1
#define FAN_PIN 5
#define BUZZER_PIN 6
#define TRIG_PIN 9
#define ECHO_PIN 10
#define STATUS_LED_PIN LED_BUILTIN

DHT dht(DHTPIN, DHTTYPE);

void setup() {
  Serial.begin(9600);
  dht.begin();
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  pinMode(FAN_PIN, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(STATUS_LED_PIN, OUTPUT);
  digitalWrite(FAN_PIN, LOW);
  digitalWrite(BUZZER_PIN, LOW);
  digitalWrite(STATUS_LED_PIN, LOW);
}

float getDistance() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  long duration = pulseIn(ECHO_PIN, HIGH, 30000);
  if (duration == 0) return -1.0;
  return duration * 0.034 / 2.0;
}

void loop() {
  float current_t = dht.readTemperature();
  float current_rh = dht.readHumidity();
  if (isnan(current_t) || isnan(current_rh)) {
    current_t = -999.0;
    current_rh = -999.0;
  }

  int fork = analogRead(FORK_PIN);
  int ldr = analogRead(LDR_PIN);
  float dist = getDistance();

  Serial.print("DATA,");
  Serial.print(current_t, 1); Serial.print(",");
  Serial.print(current_rh, 1); Serial.print(",");
  Serial.print(fork); Serial.print(",");
  Serial.print(ldr); Serial.print(",");
  Serial.println(dist, 1);

  if (Serial.available() > 0) {
    char cmd = Serial.read();
    if (cmd == 'F') digitalWrite(FAN_PIN, HIGH);
    else if (cmd == 'f') digitalWrite(FAN_PIN, LOW);
    else if (cmd == 'B') digitalWrite(BUZZER_PIN, HIGH);
    else if (cmd == 'b') digitalWrite(BUZZER_PIN, LOW);
    else if (cmd == 'G') digitalWrite(STATUS_LED_PIN, HIGH);
    else if (cmd == 'g') digitalWrite(STATUS_LED_PIN, LOW);
    while (Serial.available() > 0) Serial.read();
  }

  delay(2000);
}
