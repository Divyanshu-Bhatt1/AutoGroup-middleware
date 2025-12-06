# API Test Commands

Use these commands to test the `server.js` endpoints. Ensure your server is running (`node server.js`) before executing these.

## 1. Fetch Customer Detail
Retrieves customer name and ID by phone number.

**Git Bash / Mac / Linux / PowerShell (Newer):**
```bash
curl -X POST http://localhost:3000/fetch-customer-detail \
  -H "Content-Type: application/json" \
  -d '{"phone": "555-123-4567"}'
```

**Windows Command Prompt (cmd.exe):**
```cmd
curl -X POST http://localhost:3000/fetch-customer-detail ^
  -H "Content-Type: application/json" ^
  -d "{\"phone\": \"555-123-4567\"}"
```

## 2. Check Availability
Checks for available 30-minute slots within a range.

**Git Bash / Mac / Linux / PowerShell (Newer):**
```bash
curl -X POST http://localhost:3000/check-availability \
  -H "Content-Type: application/json" \
  -d '{
    "startRange": "2025-11-25T09:00:00Z",
    "endRange": "2025-11-25T17:00:00Z"
  }'
```

**Windows Command Prompt (cmd.exe):**
```cmd
curl -X POST http://localhost:3000/check-availability ^
  -H "Content-Type: application/json" ^
  -d "{\"startRange\": \"2025-11-25T09:00:00Z\", \"endRange\": \"2025-11-25T17:00:00Z\"}"
```

## 3. Booking
Books an appointment. Creates customer/vehicle if missing.

**Git Bash / Mac / Linux / PowerShell (Newer):**
```bash
curl -X POST http://localhost:3000/booking \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "555-123-4567",
    "name": "John Doe",
    "make": "Toyota",
    "model": "Camry",
    "title": "Oil Change",
    "startDate": "2025-11-25T10:00:00Z"
  }'
```

**Windows Command Prompt (cmd.exe):**
```cmd
curl -X POST http://localhost:3000/booking ^
  -H "Content-Type: application/json" ^
  -d "{\"phone\": \"555-123-4567\", \"name\": \"John Doe\", \"make\": \"Toyota\", \"model\": \"Camry\", \"title\": \"Oil Change\", \"startDate\": \"2025-11-25T10:00:00Z\"}"
```

## 4. Verify Appointment
Verifies an appointment exists and matches vehicle details.

**Git Bash / Mac / Linux / PowerShell (Newer):**
```bash
curl -X POST http://localhost:3000/verify-appointment \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "555-123-4567",
    "make": "Toyota",
    "model": "Camry",
    "originalDate": "2025-11-25T10:00:00.000Z"
  }'
```

**Windows Command Prompt (cmd.exe):**
```cmd
curl -X POST http://localhost:3000/verify-appointment ^
  -H "Content-Type: application/json" ^
  -d "{\"phone\": \"555-123-4567\", \"make\": \"Toyota\", \"model\": \"Camry\", \"originalDate\": \"2025-11-25T10:00:00.000Z\"}"
```

## 5. Cancel Appointment
Cancels an appointment by phone and date.

**Git Bash / Mac / Linux / PowerShell (Newer):**
```bash
curl -X POST http://localhost:3000/cancel-appointment \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "555-123-4567",
    "originalDate": "2025-11-25T10:00:00.000Z"
  }'
```

**Windows Command Prompt (cmd.exe):**
```cmd
curl -X POST http://localhost:3000/cancel-appointment ^
  -H "Content-Type: application/json" ^
  -d "{\"phone\": \"555-123-4567\", \"originalDate\": \"2025-11-25T10:00:00.000Z\"}"
```

## 6. Update Appointment
Updates an appointment to a new time.

**Git Bash / Mac / Linux / PowerShell (Newer):**
```bash
curl -X POST http://localhost:3000/update-appointment \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "555-123-4567",
    "originalDate": "2025-11-25T10:00:00.000Z",
    "newDate": "2025-11-26T14:00:00.000Z"
  }'
```

**Windows Command Prompt (cmd.exe):**
```cmd
curl -X POST http://localhost:3000/update-appointment ^
  -H "Content-Type: application/json" ^
  -d "{\"phone\": \"555-123-4567\", \"originalDate\": \"2025-11-25T10:00:00.000Z\", \"newDate\": \"2025-11-26T14:00:00.000Z\"}"
```

## 7. Identify Caller
Retrieves customer context (Active Orders and Future Appointments) for Voice AI.

**Git Bash / Mac / Linux / PowerShell (Newer):**
```bash
curl -X POST http://localhost:3000/identify-caller \
  -H "Content-Type: application/json" \
  -d '{"phone": "555-123-4567"}'
```

**Windows Command Prompt (cmd.exe):**
```cmd
curl -X POST http://localhost:3000/identify-caller ^
  -H "Content-Type: application/json" ^
  -d "{\"phone\": \"555-123-4567\"}"
```
