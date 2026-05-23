import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Stripe from "stripe";
import axios from "axios";
import jwt from "jsonwebtoken";
import crypto from "crypto";

dotenv.config();

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

app.use(express.json());
app.use(cors({ origin: "*" }));

const POCKETBASE_URL = process.env.POCKETBASE_URL;
async function getPocketBaseAdminToken() {
  if (!POCKETBASE_URL) {
    throw new Error("POCKETBASE_URL is missing");
  }

  if (!process.env.POCKETBASE_ADMIN_EMAIL || !process.env.POCKETBASE_ADMIN_PASSWORD) {
    throw new Error("PocketBase admin credentials are missing");
  }

  const response = await axios.post(
    `${POCKETBASE_URL}/api/admins/auth-with-password`,
    {
      identity: process.env.POCKETBASE_ADMIN_EMAIL,
      password: process.env.POCKETBASE_ADMIN_PASSWORD,
    }
  );

  return response.data.token;
}

app.get("/", (req, res) => {
  res.send("NextGen Backend Running");
});

app.get("/hcgi/api/live-class/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;

    if (!sessionId) {
      return res.status(400).json({ allowed: false, error: "sessionId is required" });
    }

    const authHeader = req.headers.authorization || "";
    const token = authHeader.replace("Bearer ", "").trim();

    if (!token) {
      return res.status(401).json({ allowed: false, error: "User not authenticated" });
    }

    if (!POCKETBASE_URL) {
      return res.status(500).json({
        allowed: false,
        error: "POCKETBASE_URL is missing in backend environment variables",
      });
    }

    const userRefresh = await axios.post(
      `${POCKETBASE_URL}/api/collections/users/auth-refresh`,
      {},
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const user = userRefresh.data.record;

    if (!user?.id) {
      return res.status(401).json({ allowed: false, error: "Invalid user token" });
    }

    const userId = user.id;

    const sessionResponse = await axios.get(
      `${POCKETBASE_URL}/api/collections/live_sessions/records/${sessionId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const session = sessionResponse.data;

    if (!session?.id) {
      return res.status(404).json({ allowed: false, error: "Session not found" });
    }

    const courseId = session.course_id;

    if (!courseId) {
      return res.status(400).json({ allowed: false, error: "Session missing course_id" });
    }

    let allowed = false;
    let reason = "You don't have access to this session";

    if (user.role === "admin") {
      allowed = true;
    } else if (user.role === "instructor" || session.instructor_id === userId) {
      allowed = true;
    } else {
      try {
        const filter = encodeURIComponent(
          `user_id="${userId}" && course_id="${courseId}" && access_granted=true`
        );

        const enrollmentResponse = await axios.get(
          `${POCKETBASE_URL}/api/collections/enrollments/records?filter=${filter}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );

        if (enrollmentResponse.data?.items?.length > 0) {
          allowed = true;
        }
      } catch {
        allowed = false;
      }
    }

    if (!allowed) {
      return res.json({ allowed: false, reason });
    }

    return res.json({
      allowed: true,
      session: {
        id: session.id,
        topic: session.topic || null,
        zoom_meeting_id: session.zoom_meeting_id || null,
        meeting_password: session.meeting_password || null,
        scheduled_date: session.scheduled_date || null,
        scheduled_time: session.scheduled_time || null,
        course_id: session.course_id || null,
        instructor_id: session.instructor_id || null,
        instructor_name: session.instructor_name || null,
        status: session.status || "scheduled",
        zoom_join_url: session.zoom_meeting_url || null,
        recording_url: session.recording_url || null,
      },
    });
  } catch (error) {
    console.error("Live classroom error:", error.response?.data || error.message);

    return res.status(error.response?.status || 500).json({
      allowed: false,
      error:
        error.response?.data?.message ||
        error.response?.data?.error ||
        error.message ||
        "Failed to load live classroom",
    });
  }
});

app.post("/stripe/create-checkout", async (req, res) => {
  try {
    const { enrollmentId, amount, studentId, courseId, successUrl, cancelUrl } = req.body;

    const amountInCents = Math.round(Number(amount) * 100);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: "NextGen USMLE Enrollment" },
            unit_amount: amountInCents,
          },
          quantity: 1,
        },
      ],
      metadata: { enrollmentId, studentId, courseId },
      success_url: successUrl || "https://live.nextgenusmlelms.com/payment-success",
      cancel_url: cancelUrl || "https://live.nextgenusmlelms.com/payment-cancel",
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe Error:", err);
    res.status(500).json({ error: err.message });
  }
});

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

app.get("/zoom/zak", async (req, res) => {
  try {
    const accessToken = await getZoomAccessToken();

    const response = await axios.get(
      "https://api.zoom.us/v2/users/me/token?type=zak",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    res.json({
      zak: response.data.token,
    });
  } catch (error) {
    console.error("ZAK Error:", error.response?.data || error.message);

    res.status(500).json({
      error: error.response?.data || error.message,
    });
  }
});

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
    console.error("Zoom Error:", error.response?.data || error.message);

    res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
    });
  }
});

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

    const signature = jwt.sign(payload, process.env.ZOOM_MEETING_SDK_SECRET, {
      algorithm: "HS256",
    });

    res.json({ signature });
  } catch (error) {
    console.error("Signature Error:", error);
    res.status(500).json({ error: error.message });
  }
});
app.post("/zoom/webhook", async (req, res) => {
  try {
    const event = req.body.event;

    console.log("Zoom webhook received:", event);
    console.log("Zoom webhook body:", JSON.stringify(req.body, null, 2));

    if (event === "endpoint.url_validation") {
      const plainToken = req.body.payload.plainToken;

      const encryptedToken = crypto
        .createHmac("sha256", process.env.ZOOM_WEBHOOK_SECRET_TOKEN)
        .update(plainToken)
        .digest("hex");

      return res.status(200).json({
        plainToken,
        encryptedToken,
      });
    }

    if (event === "recording.completed") {
      const recordingObject = req.body.payload.object;

      const zoomMeetingId = recordingObject.id;
      const zoomUuid = recordingObject.uuid;
      const topic = recordingObject.topic;
      const startTime = recordingObject.start_time;
      const duration = recordingObject.duration;
      const recordingFiles = recordingObject.recording_files || [];

      const videoFile =
        recordingFiles.find((file) => file.file_type === "MP4") ||
        recordingFiles[0];

      const recordingUrl =
        videoFile?.play_url || videoFile?.download_url || null;

      console.log("Recording completed:");
      console.log("Meeting ID:", zoomMeetingId);
      console.log("Zoom UUID:", zoomUuid);
      console.log("Topic:", topic);
      console.log("Start Time:", startTime);
      console.log("Duration:", duration);
      console.log("Recording URL:", recordingUrl);
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error("Zoom webhook error:", error.response?.data || error.message);

    return res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
    });
  }
});
app.get("/health", (req, res) => {
  res.json({
    success: true,
    message: "Backend running",
  });
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
