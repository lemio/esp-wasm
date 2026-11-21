// Change the blink speed from the page: type a digit from 1 to 9 in the box under the Output panel
// and press Enter. The delay becomes that many hundred milliseconds (1 = fast, 9 = slow).
// Works with Serial via SWIO and with Serial via USB.
#if defined(CH32X035)
#define LED_PIN PB12  // change for your board
#else
#define LED_PIN PD0
#endif

unsigned long wait = 500;  // ms

void setup() {
  pinMode(LED_PIN, OUTPUT);
  Serial.begin(115200);
  Serial.println("Type 1-9 (x 100 ms) to set the blink delay");
}

void loop() {
  while (Serial.available()) {
    int c = Serial.read();
    if (c >= '1' && c <= '9') {
      wait = (c - '0') * 100UL;
      Serial.print("delay = ");
      Serial.print(wait);
      Serial.println(" ms");
    }
  }
  digitalWrite(LED_PIN, HIGH);
  delay(wait);
  digitalWrite(LED_PIN, LOW);
  delay(wait);
}
