import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Stripe from "stripe";
import axios from "axios";
import jwt from "jsonwebtoken";

dotenv.config();

const app = express();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

app.use(express.json());

app.use(
  cors({
    origin: "*",
  })
);

app.get("/", (req, res) => {
  res.send("NextGen Backend Running");
});

//
// STRIPE CHECKOUT
//
app.post("/stripe/create-checkout", async (req, res) => {
  try {
    const {
      enrollmentId,
      amount,
      studentId,
      courseId,
      successUrl,
      cancelUrl,
    } = req.body;

    const amountInCents = Math.round(Number(amount) * 100);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],

      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: "NextGen USMLE Enrollment",
            },
            unit_amount: amountInCents,
          },
          quantity: 1,
        },
      ],

      metadata: {
        enrollmentId,
        studentId,
        courseId,
      },

      success_url:
        successUrl ||
        "https://live.nextgenusmlelms.com/payment-success",

      cancel_url:
        cancelUrl ||
        "https://live.nextgenusmlelms.com/payment-cancel",
    });

    res.json({
      url: session.url,
    });
  } catch (err) {
    console.error("Stripe Error:", err);

    res.status(500).json({
      error: err.message,
    });
  }
});

//
// ZOOM OAUTH ACCESS TOKEN
//
async function getZoomAccessToken() {
  const response = await axios.post(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${process.env.ZOOM_ACCOUNT_ID}`,
    {},
    {
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(
            `${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`
          ).toString("base64"),
      },
    }
  );

  return response.data.access_token;
}

//
// CREATE ZOOM MEETING
//
app.post("/zoom/create-meeting", async (req, res) => {
  try {
    const { topic, start_time, duration } = req.body;

    const accessToken = await getZoomAccessToken();

    const response = await axios.post(
      "https://api.zoom.us/v2/users/me/meetings",
      {
        topic,
        type: 2,
        start_time,
        duration,
        timezone: "Asia/Karachi",

        settings: {
          host_video: true,
          participant_video: true,
          join_before_host: false,
          waiting_room: true,
          auto_recording: "cloud",
        },
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    res.json({
      success: true,
      meeting: response.data,
    });
  } catch (error) {
    console.error(
      "Zoom Error:",
      error.response?.data || error.message
    );

    res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
    });
  }
});

//
// GENERATE ZOOM SDK SIGNATURE
//
app.post("/zoom/generate-signature", async (req, res) => {
  try {
    const { meetingNumber, role } = req.body;

    const iat = Math.round(new Date().getTime() / 1000) - 30;
    const exp = iat + 60 * 60 * 2;

    const payload = {
      sdkKey: process.env.ZOOM_MEETING_SDK_KEY,
      mn: meetingNumber,
      role,
      iat,
      exp,
      appKey: process.env.ZOOM_MEETING_SDK_KEY,
      tokenExp: exp,
    };

    const signature = jwt.sign(
      payload,
      process.env.ZOOM_MEETING_SDK_SECRET,
      {
        algorithm: "HS256",
      }
    );

    res.json({
      signature,
    });
  } catch (error) {
    console.error("Signature Error:", error);

    res.status(500).json({
      error: error.message,
    });
  }
});

//
// HEALTH CHECK
//
app.get("/health", (req, res) => {
  res.json({
    success: true,
    message: "Backend running",
  });
});

//
// START SERVER
//
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
