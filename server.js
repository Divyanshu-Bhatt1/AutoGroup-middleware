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

app.post("/create-customer", async (req, res, next) => {
  const customerInfo = req.body;
  if (!customerInfo.name || !customerInfo.phone) {
    return res
      .status(400)
      .json({
        success: false,
        message: "Client error: Missing required fields 'name' and 'phone'.",
      });
  }
  try {
    const { customerData, wasCreated, customerName } =
      await findOrCreateCustomer(customerInfo);
    const message = wasCreated
      ? `Successfully created new customer: ${customerName}.`
      : `Found existing customer: ${customerName}.`;
    console.log(`[SUCCESS] /create-customer: ${message}`);
    return res
      .status(200)
      .json({ success: true, message: message, customer: customerData });
  } catch (error) {
    return next(error);
  }
});

app.post("/create-vehicle", async (req, res, next) => {
  const {
    customerId,
    year,
    make,
    model,
    licensePlateState,
    licensePlate,
    size,
  } = req.body;
  if (!customerId || !make || !model) {
    return res
      .status(400)
      .json({
        success: false,
        message:
          "Client error: Missing required fields 'customerId', 'make', and 'model'.",
      });
  }
  try {
    const vehicleDetails = {
      year,
      make,
      model,
      licensePlateState,
      licensePlate,
      size,
    };
    const { vehicleData, wasCreated, vehicleName } = await findOrCreateVehicle(
      customerId,
      vehicleDetails
    );
    const message = wasCreated
      ? `Successfully created new vehicle: ${vehicleName}.`
      : `Found existing vehicle: ${vehicleName}.`;
    console.log(`[SUCCESS] /create-vehicle: ${message}`);
    return res
      .status(200)
      .json({ success: true, message: message, vehicle: vehicleData });
  } catch (error) {
    return next(error);
  }
});

// --- [CORRECTED] API Endpoint: Book Appointment ---
app.post("/book-appointment", async (req, res, next) => {
  const { phone, makeModel, title, startDate, durationMinutes } = req.body;
  if (!phone || !makeModel || !title || !startDate || !durationMinutes) {
    return res
      .status(400)
      .json({
        success: false,
        message: "Client error: Missing required fields.",
      });
  }
  try {
    const customer = await findCustomerByPhone(phone);
    if (!customer) {
      console.log(
        `[FAIL] /book-appointment: Customer with phone ${phone} not found.`
      );
      return res
        .status(404)
        .json({
          success: false,
          message: `Could not find a customer with the phone number ${phone}. Please create the customer first.`,
        });
    }
    const customerName = `${customer.firstName || ""} ${
      customer.lastName || ""
    }`.trim();

    // Reverted to the original, more reliable findVehicle helper call
    const vehicle = await findVehicle(customer.id, { makeModel });
    
    if (!vehicle) {
      console.log(
        `[FAIL] /book-appointment: Vehicle "${makeModel}" not found for customer ${customer.id}.`
      );
      return res
        .status(404)
        .json({
          success: false,
          message: `Could not find a vehicle matching "${makeModel}" for ${customerName}. Please create the vehicle first.`,
        });
    }

    const start = new Date(startDate);
    const end = new Date(start.getTime() + durationMinutes * 60000);
    const appointmentPayload = {
      customerId: customer.id,
      vehicleId: vehicle.id,
      locationId: LOCATION_ID,
      name: title,
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      color: "purple",
    };
    await shopmonkeyApi.post("/appointment", appointmentPayload);
    const localAppointmentTime = formatToShopTime(start);
    // Use the vehicle details for a more accurate message
    const vehicleName = `${vehicle.year || ''} ${vehicle.make} ${vehicle.model}`.trim();
    const successMessage = `Success! Appointment confirmed for ${customerName} for the ${vehicleName} on ${localAppointmentTime}.`;
    
    console.log(`[SUCCESS] /book-appointment: ${successMessage}`);
    return res.status(201).json({ success: true, message: successMessage });
  } catch (error) {
    return next(error);
  }
});

app.post("/check-availability", async (req, res, next) => {
  const { startRange, endRange, durationMinutes } = req.body;
  if (!startRange || !endRange || !durationMinutes) {
    return res
      .status(400)
      .json({ success: false, message: "Missing required parameters." });
  }
  try {
    const searchPayload = {
      where: {
        locationId: { _eq: LOCATION_ID },
        startDate: { gte: startRange },
        endDate: { lte: endRange },
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
    while (currentTime < new Date(endRange)) {
      const { hour, day } = getShopHourAndDay(currentTime);
      // Check for weekdays (Mon-Fri) and business hours
      if (
        day > 0 &&
        day < 6 &&
        hour >= businessHours.start &&
        hour < businessHours.end
      ) {
        potentialSlots.push(new Date(currentTime));
      }
      // Increment by a fixed interval, e.g., 30 minutes
      currentTime.setMinutes(currentTime.getMinutes() + 30);
    }
    const availableSlots = potentialSlots.filter((slotStart) => {
      const slotEnd = new Date(slotStart.getTime() + durationMinutes * 60000);
      const isOverlapping = existingAppointments.some(
        (appt) =>
          new Date(appt.startDate) < slotEnd &&
          new Date(appt.endDate) > slotStart
      );
      return !isOverlapping;
    });
    res
      .status(200)
      .json({
        success: true,
        message: `Found ${availableSlots.length} available slots.`,
        availableSlots: availableSlots.map((date) => date.toISOString()),
      });
  } catch (error) {
    return next(error);
  }
});

// --- [CORRECTED] API Endpoint: Check Appointment Status ---
// --- [CORRECTED] API Endpoint: Check Appointment Status ---
app.post("/check-status", async (req, res, next) => {
  const { phone } = req.body;
  if (!phone) {
    return res.status(400).json({
      success: false,
      message: "Client error: Missing required field 'phone'.",
    });
  }

  try {
    const customer = await findCustomerByPhone(phone);
    if (!customer) {
      return res.status(404).json({
        success: false,
        message: "Could not find a customer with that phone number.",
      });
    }

    // Search for the customer's next upcoming appointment
    const now = new Date().toISOString();
    const appointmentsResponse = await shopmonkeyApi.post("/appointment/search", {
      where: {
        locationId: LOCATION_ID, // Also simplifying this based on common API patterns
        // --- THIS IS THE FIX ---
        // Changed from an object to a direct string value as required by the API.
        customerId: customer.id,
        // ----------------------
        startDate: { gte: now }, // This field correctly uses an object
      },
      orderBy: { startDate: 'asc' }, 
      limit: 1, 
    });

    const nextAppointment = appointmentsResponse.data.data?.[0];

    // Case 1: No upcoming appointment was found
    if (!nextAppointment) {
      const customerName = `${customer.firstName || ""} ${customer.lastName || ""}`.trim();
      const message = `I found customer ${customerName}, but they have no upcoming appointments scheduled.`;
      console.log(`[SUCCESS] /check-status (No Appointment Found): ${message}`);
      return res.status(200).json({
        success: true,
        appointmentStatus: "not_found",
        message: message,
      });
    }

    // Case 2: An appointment was found, now determine its status
    const vehicleResponse = await shopmonkeyApi.get(`/vehicle/${nextAppointment.vehicleId}`);
    const vehicle = vehicleResponse.data.data;
    const vehicleName = vehicle 
      ? `${vehicle.year || ""} ${vehicle.make} ${vehicle.model}`.trim() 
      : "their vehicle";
    const appointmentTime = formatToShopTime(new Date(nextAppointment.startDate));

    let responseMessage = "";
    let appointmentStatus = "";

    // Map the Shopmonkey appointment status to "approved", "pending", etc.
    switch (nextAppointment.status) {
      case 'Confirmed':
        appointmentStatus = 'approved';
        responseMessage = `Your appointment for the ${vehicleName} on ${appointmentTime} is approved and confirmed.`;
        break;
      
      case 'Scheduled':
        appointmentStatus = 'pending_approval';
        responseMessage = `Your appointment for the ${vehicleName} on ${appointmentTime} is scheduled, but is still pending final approval from the shop.`;
        break;
      
      case 'Canceled':
        appointmentStatus = 'canceled';
        responseMessage = `The appointment for the ${vehicleName} on ${appointmentTime} has been canceled.`;
        break;
      
      default:
        appointmentStatus = 'other';
        responseMessage = `The appointment for the ${vehicleName} on ${appointmentTime} has a status of '${nextAppointment.status}'.`;
        break;
    }
    
    console.log(`[SUCCESS] /check-status (Appointment Found): Status is ${nextAppointment.status}`);
    return res.status(200).json({
      success: true,
      appointmentStatus: appointmentStatus,
      message: responseMessage,
      details: {
        vehicle: vehicleName,
        appointmentDate: nextAppointment.startDate,
        shopStatus: nextAppointment.status, // The raw status from Shopmonkey
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
    `[ERROR] Status: ${statusCode} | Path: ${req.path} | API Message: ${
      errorDetails.message || "No specific message from API."
    }`,
    errorDetails
  );

  if ((statusCode === 422 || statusCode === 409) && req.path === '/book-appointment') {
    return res
      .status(409) 
      .json({
        success: false,
        message: "That time slot appears to be unavailable or has a conflict. Please check availability again.",
      });
  }
  
  if (statusCode === 403) {
      return res.status(500).json({ success: false, message: "API Authorization Forbidden. Check your API Key." });
  }

  return res
    .status(500)
    .json({ success: false, message: "An internal server error occurred." });
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

async function findOrCreateCustomer(customerInfo) {
  const { name, phone } = customerInfo;
  const e164Phone = normalizeToE164(phone);
  
  const searchPayload = { phoneNumbers: [{ number: e164Phone }] };
  console.log("[INFO] Searching for customer with E.164 payload:", searchPayload);
  
  const searchResponse = await shopmonkeyApi.post(
    "/customer/phone_number/search",
    searchPayload
  );

  if (searchResponse.data.data && searchResponse.data.data.length > 0) {
    const customer = searchResponse.data.data[0];
    const fullName = `${customer.firstName || ""} ${customer.lastName || ""}`.trim();
    console.log(`[INFO] Found existing customer: ${fullName} (ID: ${customer.id})`);
    return {
      customerData: customer,
      wasCreated: false,
      customerName: fullName || "N/A",
    };
  }

  console.log("[INFO] No customer found. Preparing to create a new one.");

  const [firstName, ...lastNameParts] = name.split(" ");
  const createPayload = {
    name: name,
    firstName: firstName || "N/A",
    lastName: lastNameParts.join(" ") || "N/A",
    phoneNumbers: [{ number: e164Phone, primary: true }],
    customerType: "Customer",
    originLocationId: LOCATION_ID,
    locationIds: [LOCATION_ID],
  };

  const optionalFields = [
    "email",
    "address1",
    "city",
    "state",
    "postalCode",
    "note",
  ];
  optionalFields.forEach((field) => {
    if (customerInfo[field]) {
      if (field === "email") {
        createPayload.emails = [{ email: customerInfo[field], primary: true }];
      } else {
        createPayload[field] = customerInfo[field];
      }
    }
  });

  console.log("[INFO] Sending CREATE customer payload to Shopmonkey:", JSON.stringify(createPayload, null, 2));

  const createResponse = await shopmonkeyApi.post("/customer", createPayload);
  const newCustomer = createResponse.data.data;
  const newCustomerName =
    newCustomer.name ||
    `${newCustomer.firstName || ""} ${newCustomer.lastName || ""}`.trim();
    
  return {
    customerData: newCustomer,
    wasCreated: true,
    customerName: newCustomerName,
  };
}


async function findOrCreateVehicle(customerId, vehicleDetails) {
  const { year, make, model, licensePlateState, licensePlate, size } =
    vehicleDetails;
  const searchResponse = await shopmonkeyApi.get(
    `/customer/${customerId}/vehicle`
  );
  const existingVehicle = searchResponse.data.data.find(
    (v) =>
      v.make.toLowerCase().trim() === make.toLowerCase().trim() &&
      v.model.toLowerCase().trim() === model.toLowerCase().trim() &&
      (v.year == year || (!v.year && !year))
  );
  const vehicleName = `${year || ""} ${make} ${model}`.trim();
  if (existingVehicle) {
    return { vehicleData: existingVehicle, wasCreated: false, vehicleName };
  }
  const createPayload = {
    customerId,
    make,
    model,
    size: size || "LightDuty",
    licensePlateState: licensePlateState || "",
  };
  if (year) createPayload.year = year;
  if (licensePlate) createPayload.licensePlate = licensePlate;
  const createResponse = await shopmonkeyApi.post("/vehicle", createPayload);
  const newVehicle = createResponse.data.data;
  return { vehicleData: newVehicle, wasCreated: true, vehicleName };
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

// --- [CORRECTED] Helper Function: findVehicle ---
async function findVehicle(customerId, vehicleDetails) {
  const { makeModel } = vehicleDetails;
  const searchResponse = await shopmonkeyApi.get(
    `/customer/${customerId}/vehicle`
  );
  
  const existingVehicle = searchResponse.data.data.find((v) => {
    // This logic correctly handles multi-word makes/models by combining them before comparing.
    const dbVehicleName = `${v.make} ${v.model}`;
    return (
      dbVehicleName.toLowerCase().trim() === makeModel.toLowerCase().trim()
    );
  });

  return existingVehicle || null;
}

// --- Start Server ---
app.listen(PORT || 3000, () => {
  console.log(
    `[INFO] Shopmonkey Connector server running on port ${PORT || 3000}`
  );
  console.log(`[INFO] Ready to receive requests from the AI agent.`);
});