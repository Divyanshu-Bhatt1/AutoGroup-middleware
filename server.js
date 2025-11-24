require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");

// --- App Initialization & Middleware ---
const app = express();
app.use(express.json());
app.use(cors());

// --- Environment Variable Validation ---
const { PORT, SHOPMONKEY_API_KEY, LOCATION_ID } = process.env;
const SHOP_TIMEZONE = "America/Los_Angeles"; // IMPORTANT: Set this to your shop's timezone

if (!SHOPMONKEY_API_KEY || !LOCATION_ID) {
  console.error(
    "FATAL ERROR: SHOPMONKEY_API_KEY and LOCATION_ID must be defined in the .env file."
  );
  process.exit(1);
}

// --- Shopmonkey API Client (v3) ---
const shopmonkeyApi = axios.create({
  baseURL: "https://api.shopmonkey.cloud/v3",
  headers: {
    Authorization: `Bearer ${SHOPMONKEY_API_KEY}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  },
});

// --- API Endpoints ---

// 1. fetch-customer-detail API
app.post("/fetch-customer-detail", async (req, res, next) => {
  const { phone } = req.body;

  console.log(`[INFO] /fetch-customer-detail called with phone: ${phone}`);

  if (!phone) {
    console.log("[ERROR] Missing phone number");
    return res.status(400).json({
      success: false,
      message: "Client error: Missing required field 'phone'.",
    });
  }

  try {
    const customer = await findCustomerByPhone(phone);

    if (!customer) {
      console.log(`[INFO] Customer not found for phone: ${phone}`);
      return res.status(404).json({
        success: false,
        message: "Customer not found.",
      });
    }

    const fullName = `${customer.firstName || ""} ${customer.lastName || ""}`.trim();
    console.log(`[SUCCESS] Found customer: ${fullName} (${customer.id})`);

    return res.status(200).json({
      success: true,
      customerId: customer.id,
      name: fullName,
      phone: phone,
    });

  } catch (error) {
    console.error("[ERROR] /fetch-customer-detail failed:", error.message);

    // Handle Shopmonkey specific validation errors (e.g., invalid phone number)
    if (error.response && error.response.status === 400) {
      console.log("[INFO] Shopmonkey rejected the phone number (400). Returning 'Customer not found' to client.");
      return res.status(404).json({
        success: false,
        message: "Customer not found (Invalid Phone Number).",
      });
    }

    return next(error);
  }
});

// 2. check-availability API
app.post("/check-availability", async (req, res, next) => {
  const { startRange, endRange } = req.body;
  // Default duration to 30 minutes as requested
  const durationMinutes = 30;

  if (!startRange || !endRange) {
    return res
      .status(400)
      .json({ success: false, message: "Missing required parameters 'startRange' or 'endRange'." });
  }

  try {
    // Fetch existing appointments to check for conflicts
    const searchPayload = {
      where: {
        locationId: { _eq: LOCATION_ID },
        startDate: { gte: startRange },
        endDate: { lte: endRange },
        status: { _neq: "Canceled" } // Exclude canceled appointments
      },
    };

    const response = await shopmonkeyApi.post(
      "/appointment/search",
      searchPayload
    );

    const existingAppointments = response.data.data;
    const businessHours = { start: 9, end: 17 }; // 9 AM to 5 PM

    const potentialSlots = [];
    let currentTime = new Date(startRange);
    const endTime = new Date(endRange);

    // Generate 30-minute slots
    while (currentTime < endTime) {
      const { hour, day } = getShopHourAndDay(currentTime);

      // Check for weekdays (Mon-Fri) and business hours
      // 0 = Sun, 6 = Sat
      if (
        day > 0 &&
        day < 6 &&
        hour >= businessHours.start &&
        hour < businessHours.end
      ) {
        potentialSlots.push(new Date(currentTime));
      }

      // Increment by 30 minutes
      currentTime.setMinutes(currentTime.getMinutes() + 30);
    }

    // Filter slots based on conflicts
    const availableSlots = potentialSlots.filter((slotStart) => {
      const slotEnd = new Date(slotStart.getTime() + durationMinutes * 60000);

      const isOverlapping = existingAppointments.some((appt) => {
        const apptStart = new Date(appt.startDate);
        const apptEnd = new Date(appt.endDate);

        // Check for overlap
        return apptStart < slotEnd && apptEnd > slotStart;
      });

      return !isOverlapping;
    });

    res.status(200).json({
      success: true,
      message: `Found ${availableSlots.length} available slots.`,
      availableSlots: availableSlots.map((date) => date.toISOString()),
    });

  } catch (error) {
    return next(error);
  }
});

// 3. booking API
app.post("/booking", async (req, res, next) => {
  const { phone, make, model, title, startDate, name } = req.body;
  const durationMinutes = 30; // Fixed default duration

  // Basic validation
  if (!phone || !make || !model || !title || !startDate || !name) {
    return res.status(400).json({
      success: false,
      message: "Client error: Missing required fields (phone, make, model, title, startDate, name).",
    });
  }

  // Date Validation
  const start = new Date(startDate);
  if (isNaN(start.getTime())) {
    return res.status(400).json({
      success: false,
      message: "Client error: 'startDate' is invalid. Please provide a valid ISO 8601 date string.",
    });
  }

  try {
    // --- Check for Availability (Double-Booking Prevention) ---
    const end = new Date(start.getTime() + durationMinutes * 60000);

    // Search window: +/- 24 hours to ensure we catch any overlapping appointments
    // We fetch a broader range and filter in memory to be 100% sure of overlaps.
    const searchStartWindow = new Date(start.getTime() - 24 * 60 * 60 * 1000);
    const searchEndWindow = new Date(start.getTime() + 24 * 60 * 60 * 1000);

    const searchPayload = {
      where: {
        locationId: { _eq: LOCATION_ID },
        startDate: {
          gte: searchStartWindow.toISOString(),
          lte: searchEndWindow.toISOString()
        },
        status: { _neq: "Canceled" }
      },
      limit: 100, // Ensure we fetch enough appointments to find the conflict
    };

    console.log(`[INFO] Checking availability for: ${start.toISOString()} - ${end.toISOString()}`);

    const availabilityResponse = await shopmonkeyApi.post(
      "/appointment/search",
      searchPayload
    );

    const potentialConflicts = availabilityResponse.data.data || [];

    // Strict In-Memory Overlap Check
    const conflictingAppointment = potentialConflicts.find((appt) => {
      const apptStart = new Date(appt.startDate);
      const apptEnd = new Date(appt.endDate);

      // Check if this specific appointment overlaps with our requested slot
      // Overlap logic: (StartA < EndB) and (EndA > StartB)
      const isOverlapping = apptStart < end && apptEnd > start;

      if (isOverlapping) {
        console.log(`[DEBUG] Conflict found with Appt ID: ${appt.id} | Time: ${appt.startDate} - ${appt.endDate}`);
      }
      return isOverlapping;
    });

    if (conflictingAppointment) {
      console.log(`[WARN] Booking failed: Slot occupied by Appt ID ${conflictingAppointment.id}`);
      return res.status(409).json({ // 409 Conflict
        success: false,
        message: "The requested time slot is already booked. Please choose a different time.",
      });
    }

    // --- Customer & Vehicle Logic ---

    // 1. Find or Create Customer
    const { customerData, wasCreated: customerCreated } = await findOrCreateCustomer({ name, phone });

    // 2. Find or Create Vehicle
    // We use the customer ID to look for vehicles
    const { vehicleData, wasCreated: vehicleCreated } = await findOrCreateVehicle(customerData.id, { make, model });

    // --- Create Appointment ---

    // Format Title: Name / Make Model / Reason (Year removed)
    const vehicleString = `${vehicleData.make} ${vehicleData.model}`.trim();
    const appointmentTitle = `${customerData.firstName} ${customerData.lastName ? customerData.lastName[0] + '.' : ''} / ${vehicleString} / ${title}`;

    const appointmentPayload = {
      customerId: customerData.id,
      vehicleId: vehicleData.id,
      locationId: LOCATION_ID,
      name: appointmentTitle,
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      color: "blue", // Green for confirmed/new
    };

    await shopmonkeyApi.post("/appointment", appointmentPayload);

    const localAppointmentTime = formatToShopTime(start);
    const successMessage = `Success! Appointment confirmed for ${name} with ${vehicleString} on ${localAppointmentTime}.`;

    console.log(`[SUCCESS] /booking: ${successMessage}`);

    return res.status(201).json({
      success: true,
      message: successMessage,
      details: {
        customer: customerCreated ? "Created New" : "Existing",
        vehicle: vehicleCreated ? "Created New" : "Existing",
        appointmentTime: localAppointmentTime
      }
    });

  } catch (error) {
    return next(error);
  }
});


// --- Centralized Error Handling Middleware ---
app.use((error, req, res, next) => {
  const errorDetails = error.response
    ? error.response.data
    : { message: error.message, code: "LOCAL_ERROR" };
  const statusCode = error.response ? error.response.status : 500;
  console.error(
    `[ERROR] Status: ${statusCode} | Path: ${req.path} | API Message: ${errorDetails.message || "No specific message from API."
    }`,
    errorDetails
  );

  if (statusCode === 403) {
    return res.status(500).json({ success: false, message: "API Authorization Forbidden. Check your API Key." });
  }

  return res
    .status(statusCode)
    .json({ success: false, message: errorDetails.message || "An internal server error occurred." });
});

// --- Helper Functions ---

function getShopHourAndDay(utcDate) {
  const hourString = utcDate.toLocaleString("en-US", {
    timeZone: SHOP_TIMEZONE,
    hour: "2-digit",
    hour12: false,
  });
  const hour = parseInt(hourString.split(" ")[0], 10) % 24;
  const dayString = utcDate.toLocaleString("en-US", {
    timeZone: SHOP_TIMEZONE,
    weekday: "short",
  });
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { hour, day: dayMap[dayString] };
}

function formatToShopTime(utcDate) {
  return utcDate.toLocaleString("en-US", {
    timeZone: SHOP_TIMEZONE,
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function normalizeToE164(phone) {
  if (!phone) return "";
  let digitsOnly = phone.replace(/\D/g, "");
  if (digitsOnly.length === 10) {
    return `+1${digitsOnly}`;
  }
  if (digitsOnly.length === 11 && digitsOnly.startsWith("1")) {
    return `+${digitsOnly}`;
  }
  if (phone.trim().startsWith("+")) {
    return `+${digitsOnly}`;
  }
  return `+${digitsOnly}`;
}

// Levenshtein Distance for Fuzzy Matching
function levenshteinDistance(a, b) {
  const matrix = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          Math.min(
            matrix[i][j - 1] + 1,   // insertion
            matrix[i - 1][j] + 1    // deletion
          )
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

function isFuzzyMatch(str1, str2) {
  if (!str1 || !str2) return false;
  const s1 = str1.toLowerCase().trim();
  const s2 = str2.toLowerCase().trim();

  if (s1 === s2) return true;

  // Allow a small number of edits based on string length
  const maxEdits = Math.floor(Math.min(s1.length, s2.length) / 3);
  const dist = levenshteinDistance(s1, s2);

  return dist <= maxEdits;
}

async function findCustomerByPhone(phone) {
  const e164Phone = normalizeToE164(phone);
  const searchPayload = { phoneNumbers: [{ number: e164Phone }] };
  const searchResponse = await shopmonkeyApi.post(
    "/customer/phone_number/search",
    searchPayload
  );
  if (searchResponse.data.data && searchResponse.data.data.length > 0) {
    return searchResponse.data.data[0];
  }
  return null;
}

async function findOrCreateCustomer(customerInfo) {
  const { name, phone } = customerInfo;
  const existingCustomer = await findCustomerByPhone(phone);

  if (existingCustomer) {
    console.log(`[INFO] Found existing customer: ${existingCustomer.id}`);
    return {
      customerData: existingCustomer,
      wasCreated: false,
    };
  }

  console.log("[INFO] Creating new customer...");
  const e164Phone = normalizeToE164(phone);
  const [firstName, ...lastNameParts] = name.split(" ");

  const createPayload = {
    name: name,
    firstName: firstName || "N/A",
    lastName: lastNameParts.join(" ") || "",
    phoneNumbers: [{ number: e164Phone, primary: true }],
    customerType: "Customer",
    originLocationId: LOCATION_ID,
    locationIds: [LOCATION_ID],
  };

  const createResponse = await shopmonkeyApi.post("/customer", createPayload);
  return {
    customerData: createResponse.data.data,
    wasCreated: true,
  };
}

async function findOrCreateVehicle(customerId, vehicleDetails) {
  const { make, model } = vehicleDetails;

  // Fetch all vehicles for the customer
  const searchResponse = await shopmonkeyApi.get(
    `/customer/${customerId}/vehicle`
  );

  const vehicles = searchResponse.data.data || [];

  // Fuzzy search for matching vehicle
  const existingVehicle = vehicles.find((v) => {
    const makeMatch = isFuzzyMatch(v.make, make);
    const modelMatch = isFuzzyMatch(v.model, model);
    return makeMatch && modelMatch;
  });

  if (existingVehicle) {
    console.log(`[INFO] Found existing vehicle (Fuzzy Match): ${existingVehicle.id} - ${existingVehicle.make} ${existingVehicle.model}`);
    return { vehicleData: existingVehicle, wasCreated: false };
  }

  console.log("[INFO] Creating new vehicle...");
  const createPayload = {
    customerId,
    make,
    model,
    size: "LightDuty", // Default
  };

  const createResponse = await shopmonkeyApi.post("/vehicle", createPayload);
  return { vehicleData: createResponse.data.data, wasCreated: true };
}

// --- Start Server ---
app.listen(PORT || 3000, () => {
  console.log(
    `[INFO] Shopmonkey Connector server running on port ${PORT || 3000}`
  );
  console.log(`[INFO] Ready to receive requests.`);
});