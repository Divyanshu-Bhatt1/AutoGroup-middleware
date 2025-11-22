# API Testing Commands

Here are the cURL commands to test the Shopmonkey Middleware APIs.

## 1. Create Customer & Vehicle (Combined)
Creates a customer and links a vehicle to them in one go.
**Required Fields:** `name`, `phone`, `make`, `model`
**Optional Fields:** `licensePlate`

```bash
curl -X POST http://localhost:3000/create-customer-vehicle \
  -H "Content-Type: application/json" \
  -d '{
    "name": "John Doe",
    "phone": "555-0199",
    "make": "Toyota",
    "model": "Camry",
    "year": "2015",
    "licensePlate": "ABC-1234"
  }'
```

## 2. Check Availability
Checks for available appointment slots.
**Required Fields:** `startRange` (ISO date), `endRange` (ISO date), `durationMinutes`

```bash
curl -X POST http://localhost:3000/check-availability \
  -H "Content-Type: application/json" \
  -d '{
    "startRange": "2025-11-23T09:00:00.000Z",
    "endRange": "2025-11-23T17:00:00.000Z",
    "durationMinutes": 60
  }'
```

## 3. Book Appointment
Books an appointment for a customer.
**Required Fields:** `phone`, `makeModel`, `title`, `startDate`, `durationMinutes`

```bash
curl -X POST http://localhost:3000/book-appointment \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "555-0199",
    "makeModel": "Toyota Camry",
    "title": "Oil Change",
    "startDate": "2025-11-24T10:00:00.000Z",
    "durationMinutes": 60
  }'
```

## 4. Check Appointment Status
Checks the status of the upcoming appointment for a customer.
**Required Fields:** `phone`

```bash
curl -X POST http://localhost:3000/check-status \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "555-0199"
  }'
```
