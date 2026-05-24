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

app.use(express.json({ limit: "10mb" }));
app.use(cors({ origin: "*" }));

const POCKETBASE_URL = process.env.POCKETBASE_URL;

function getTimezoneOffsetMs(timeZone, date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);

  const values = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }

  const asUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second)
  );

  return asUtc - date.getTime();
}

function getSessionStartUtc(
  scheduledDate,
  scheduledTime,
  timezone = "America/New_York"
) {
  if (!scheduledDate || !scheduledTime) {
    return null;
  }

  const dateStr = String(scheduledDate).split(" ")[0];
  const timeStr = String(scheduledTime).trim();

  const [year, month, day] = dateStr.split("-").map(Number);
  const [hour, minute] = timeStr.split(":").map(Number);

  if (!year || !month || !day || Number.isNaN(hour) || Number.isNaN(minute)) {
    return null;
  }

  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const offset = getTimezoneOffsetMs(timezone, utcGuess);

  return new Date(utcGuess.getTime() - offset);
}

function toDateString(date) {
  return date.toISOString().split("T")[0];
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function buildClassDates({ startDate, classCount, skipSundays }) {
  const dates = [];

  if (!startDate || !classCount) {
    return dates;
  }

  let cursor = new Date(`${startDate}T00:00:00`);

  while (dates.length < Number(classCount)) {
    const isSunday = cursor.getDay() === 0;

    if (!(skipSundays && isSunday)) {
      dates.push(toDateString(cursor));
    }

    cursor = addDays(cursor, 1);
  }

  return dates;
}

function isAdminOrInstructor(user, session) {
  return (
    user?.role === "admin" ||
    user?.role === "instructor" ||
    session?.instructor_id === user?.id
  );
}

function isSessionLocked(session) {
  return (
    session.status === "completed" ||
    session.status === "cancelled" ||
    session.status === "holiday" ||
    Boolean(session.zoom_meeting_id)
  );
}

async function getPocketBaseUserFromToken(token) {
  const userRefresh = await axios.post(
    `${POCKETBASE_URL}/api/collections/users/auth-refresh`,
    {},
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
  );

  return userRefresh.data.record;
}

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

async function createZoomMeetingForLiveSession(session) {
  const accessToken = await getZoomAccessToken();

  const timezone = session.scheduled_timezone || "America/New_York";

  const sessionStartUtc = getSessionStartUtc(
    session.scheduled_date,
    session.scheduled_time,
    timezone
  );

  if (!sessionStartUtc) {
    throw new Error("Session scheduled date/time is invalid");
  }

  const duration = Number(session.duration || 120);

  const response = await axios.post(
    "https://api.zoom.us/v2/users/me/meetings",
    {
      topic: session.topic || "Live Class",
      type: 2,
      start_time: sessionStartUtc.toISOString(),
      duration,
      timezone,
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

  return response.data;
}

async function getLastScheduledSessionForCourse(courseId, token) {
  const response = await axios.get(
    `${POCKETBASE_URL}/api/collections/live_sessions/records?perPage=1&filter=${encodeURIComponent(
      `course_id="${courseId}"`
    )}&sort=-scheduled_date,-scheduled_time`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
  );

  return response.data?.items?.[0] || null;
}

function getNextClassDateAfter(dateString, skipSundays = true) {
  let cursor = addDays(new Date(`${dateString}T00:00:00`), 1);

  while (skipSundays && cursor.getDay() === 0) {
    cursor = addDays(cursor, 1);
  }

  return toDateString(cursor);
}

app.get("/", (req, res) => {
  res.send("NextGen Backend Running");
});

app.get("/health", (req, res) => {
  res.json({
    success: true,
    message: "Backend running",
  });
});

app.get("/hcgi/api/live-class/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;

    if (!sessionId) {
      return res.status(400).json({
        allowed: false,
        error: "sessionId is required",
      });
    }

    const authHeader = req.headers.authorization || "";
    const token = authHeader.replace("Bearer ", "").trim();

    if (!token) {
      return res.status(401).json({
        allowed: false,
        error: "User not authenticated",
      });
    }

    if (!POCKETBASE_URL) {
      return res.status(500).json({
        allowed: false,
        error: "POCKETBASE_URL is missing in backend environment variables",
      });
    }

    const user = await getPocketBaseUserFromToken(token);

    if (!user?.id) {
      return res.status(401).json({
        allowed: false,
        error: "Invalid user token",
      });
    }

    const userId = user.id;

    const sessionResponse = await axios.get(
      `${POCKETBASE_URL}/api/collections/live_sessions/records/${sessionId}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    let session = sessionResponse.data;

    if (!session?.id) {
      return res.status(404).json({
        allowed: false,
        error: "Session not found",
      });
    }

    const courseId = session.course_id;

    if (!courseId) {
      return res.status(400).json({
        allowed: false,
        error: "Session missing course_id",
      });
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
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        );

        if (enrollmentResponse.data?.items?.length > 0) {
          allowed = true;
        }
      } catch {
        allowed = false;
      }
    }

    if (!allowed) {
      return res.json({
        allowed: false,
        reason,
      });
    }

    if (session.status === "holiday") {
      return res.json({
        allowed: true,
        can_join: false,
        join_reason:
          session.holiday_reason ||
          "Tutor is unavailable today. This class has been marked as a holiday.",
        join_opens_at: null,
        session: {
          id: session.id,
          topic: session.topic || null,
          zoom_meeting_id: null,
          meeting_password: null,
          scheduled_date: session.scheduled_date || null,
          scheduled_time: session.scheduled_time || null,
          scheduled_timezone: session.scheduled_timezone || "America/New_York",
          course_id: session.course_id || null,
          instructor_id: session.instructor_id || null,
          instructor_name: session.instructor_name || null,
          status: session.status || "holiday",
          zoom_join_url: null,
          recording_url: session.recording_url || null,
        },
      });
    }

    const timezone = session.scheduled_timezone || "America/New_York";

    const sessionStartUtc = getSessionStartUtc(
      session.scheduled_date,
      session.scheduled_time,
      timezone
    );

    let canJoin = false;
    let joinReason = null;
    let joinOpensAt = null;

    if (session.status === "completed" || session.status === "cancelled") {
      canJoin = false;
      joinReason = `Session is ${session.status}`;
    } else if (!sessionStartUtc) {
      canJoin = false;
      joinReason = "Session date/time is not configured correctly";
    } else {
      const now = new Date();
      const joinOpenTime = new Date(sessionStartUtc.getTime() - 60 * 1000);
      joinOpensAt = joinOpenTime.toISOString();

      canJoin = now.getTime() >= joinOpenTime.getTime();

      if (!canJoin) {
        joinReason = "Classroom opens 1 minute before class starts";
      }
    }

    const userCanGenerateZoom = isAdminOrInstructor(user, session);

    if (
      canJoin &&
      !session.zoom_meeting_id &&
      session.status !== "completed" &&
      session.status !== "cancelled" &&
      session.status !== "holiday"
    ) {
      if (!userCanGenerateZoom) {
        return res.json({
          allowed: true,
          can_join: false,
          join_reason: "Waiting for tutor to open the classroom",
          join_opens_at: joinOpensAt,
          session: {
            id: session.id,
            topic: session.topic || null,
            zoom_meeting_id: null,
            meeting_password: null,
            scheduled_date: session.scheduled_date || null,
            scheduled_time: session.scheduled_time || null,
            scheduled_timezone: timezone,
            course_id: session.course_id || null,
            instructor_id: session.instructor_id || null,
            instructor_name: session.instructor_name || null,
            status: session.status || "scheduled",
            zoom_join_url: null,
            recording_url: session.recording_url || null,
          },
        });
      }

      console.log("Generating Zoom meeting for live session:", session.id);

      const meeting = await createZoomMeetingForLiveSession(session);

      const updateResponse = await axios.patch(
        `${POCKETBASE_URL}/api/collections/live_sessions/records/${session.id}`,
        {
          zoom_meeting_id: String(meeting.id),
          meeting_password: meeting.password || "",
          zoom_meeting_url: meeting.join_url || "",
          zoom_generation_status: "generated",
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      session = updateResponse.data;

      console.log("Zoom meeting generated and saved for session:", session.id);
    }

    return res.json({
      allowed: true,
      can_join: canJoin && Boolean(session.zoom_meeting_id),
      join_reason:
        canJoin && session.zoom_meeting_id
          ? "Classroom is open"
          : joinReason || "Waiting for Zoom meeting generation",
      join_opens_at: joinOpensAt,
      session: {
        id: session.id,
        topic: session.topic || null,
        zoom_meeting_id: canJoin ? session.zoom_meeting_id || null : null,
        meeting_password: canJoin ? session.meeting_password || null : null,
        scheduled_date: session.scheduled_date || null,
        scheduled_time: session.scheduled_time || null,
        scheduled_timezone: timezone,
        course_id: session.course_id || null,
        instructor_id: session.instructor_id || null,
        instructor_name: session.instructor_name || null,
        status: session.status || "scheduled",
        zoom_join_url: canJoin ? session.zoom_meeting_url || null : null,
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
      details: error.response?.data || null,
    });
  }
});

app.post("/course-schedule/sync", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.replace("Bearer ", "").trim();

    if (!token) {
      return res.status(401).json({
        success: false,
        error: "User not authenticated",
      });
    }

    if (!POCKETBASE_URL) {
      return res.status(500).json({
        success: false,
        error: "POCKETBASE_URL is missing",
      });
    }

    const user = await getPocketBaseUserFromToken(token);

    if (!user?.id || user.role !== "admin") {
      return res.status(403).json({
        success: false,
        error: "Only admins can sync course schedules",
      });
    }

    const {
      course_id,
      course_name,
      instructor_name,
      schedule_start_date,
      class_count,
      class_time,
      scheduled_timezone = "America/New_York",
      skip_sundays = true,
      default_duration = 120,
    } = req.body;

    if (!course_id) {
      return res.status(400).json({
        success: false,
        error: "course_id is required",
      });
    }

    if (!schedule_start_date || !class_count || !class_time) {
      return res.status(400).json({
        success: false,
        error: "schedule_start_date, class_count, and class_time are required",
      });
    }

    const desiredDates = buildClassDates({
      startDate: schedule_start_date,
      classCount: Number(class_count),
      skipSundays: Boolean(skip_sundays),
    });

    const existingResponse = await axios.get(
      `${POCKETBASE_URL}/api/collections/live_sessions/records?perPage=500&filter=${encodeURIComponent(
        `course_id="${course_id}"`
      )}&sort=scheduled_date,scheduled_time`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    const existingSessions = existingResponse.data?.items || [];

    const sortedSessions = [...existingSessions].sort((a, b) => {
      const aTime = `${a.scheduled_date || ""} ${a.scheduled_time || ""}`;
      const bTime = `${b.scheduled_date || ""} ${b.scheduled_time || ""}`;
      return aTime.localeCompare(bTime);
    });

    let createdCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;

    for (let index = 0; index < desiredDates.length; index += 1) {
      const classNumber = index + 1;
      const scheduledDate = desiredDates[index];
      const existing = sortedSessions[index];

      const payload = {
        topic: `${course_name || "Course"} - Class ${classNumber}`,
        instructor_name: instructor_name || "Admin",
        scheduled_date: scheduledDate,
        scheduled_time: class_time,
        scheduled_timezone,
        duration: Number(default_duration || 120),
        course_id,
        status: "scheduled",
      };

      if (existing) {
        if (isSessionLocked(existing)) {
          skippedCount += 1;
          continue;
        }

        await axios.patch(
          `${POCKETBASE_URL}/api/collections/live_sessions/records/${existing.id}`,
          {
            ...payload,
            zoom_generation_status: existing.zoom_generation_status || "pending",
          },
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        );

        updatedCount += 1;
      } else {
        await axios.post(
          `${POCKETBASE_URL}/api/collections/live_sessions/records`,
          {
            ...payload,
            zoom_meeting_id: "",
            meeting_password: "",
            zoom_meeting_url: "",
            zoom_generation_status: "pending",
          },
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        );

        createdCount += 1;
      }
    }

    return res.json({
      success: true,
      message: "Course live schedule synced successfully",
      course_id,
      total_desired_sessions: desiredDates.length,
      created: createdCount,
      updated: updatedCount,
      skipped_locked_sessions: skippedCount,
      timezone: scheduled_timezone,
      class_time,
      skip_sundays: Boolean(skip_sundays),
    });
  } catch (error) {
    console.error("Course schedule sync error:", error.response?.data || error.message);

    return res.status(error.response?.status || 500).json({
      success: false,
      error:
        error.response?.data?.message ||
        error.response?.data?.error ||
        error.message ||
        "Failed to sync course schedule",
      details: error.response?.data || null,
    });
  }
});

app.post("/course-schedule/holiday", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.replace("Bearer ", "").trim();

    if (!token) {
      return res.status(401).json({
        success: false,
        error: "User not authenticated",
      });
    }

    if (!POCKETBASE_URL) {
      return res.status(500).json({
        success: false,
        error: "POCKETBASE_URL is missing",
      });
    }

    const user = await getPocketBaseUserFromToken(token);

    if (!user?.id || (user.role !== "admin" && user.role !== "instructor")) {
      return res.status(403).json({
        success: false,
        error: "Only admins or instructors can mark holidays",
      });
    }

    const {
      session_id,
      reason = "Tutor is unavailable today.",
      notify_students = true,
      create_replacement = true,
    } = req.body;

    if (!session_id) {
      return res.status(400).json({
        success: false,
        error: "session_id is required",
      });
    }

    const sessionResponse = await axios.get(
      `${POCKETBASE_URL}/api/collections/live_sessions/records/${session_id}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    const session = sessionResponse.data;

    if (!session?.id) {
      return res.status(404).json({
        success: false,
        error: "Session not found",
      });
    }

    if (session.zoom_meeting_id) {
      return res.status(400).json({
        success: false,
        error: "Cannot mark holiday after Zoom meeting has already been generated",
      });
    }

    if (session.status === "completed") {
      return res.status(400).json({
        success: false,
        error: "Cannot mark completed session as holiday",
      });
    }

    await axios.patch(
      `${POCKETBASE_URL}/api/collections/live_sessions/records/${session.id}`,
      {
        status: "holiday",
        holiday_reason: reason,
        zoom_generation_status: "holiday",
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    let replacementSession = null;

    if (create_replacement && session.course_id) {
      const courseResponse = await axios.get(
        `${POCKETBASE_URL}/api/collections/courses/records/${session.course_id}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      const course = courseResponse.data;
      const lastSession = await getLastScheduledSessionForCourse(session.course_id, token);

      const lastDate =
        lastSession?.scheduled_date ||
        session.scheduled_date ||
        course.schedule_start_date;

      const replacementDate = getNextClassDateAfter(
        lastDate,
        course.skip_sundays !== false
      );

      const createResponse = await axios.post(
        `${POCKETBASE_URL}/api/collections/live_sessions/records`,
        {
          topic: `${course.name || session.topic || "Course"} - Replacement Class`,
          instructor_name: session.instructor_name || course.instructor_name || "Admin",
          scheduled_date: replacementDate,
          scheduled_time: course.class_time || session.scheduled_time,
          scheduled_timezone:
            course.scheduled_timezone ||
            session.scheduled_timezone ||
            "America/New_York",
          duration: Number(course.default_duration || session.duration || 120),
          course_id: session.course_id,
          status: "scheduled",
          zoom_meeting_id: "",
          meeting_password: "",
          zoom_meeting_url: "",
          zoom_generation_status: "pending",
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      replacementSession = createResponse.data;
    }

    let announcement = null;

    if (notify_students && session.course_id) {
      try {
        const announcementResponse = await axios.post(
          `${POCKETBASE_URL}/api/collections/announcements/records`,
          {
            title: "Class Holiday: Tutor Unavailable",
            content: `${session.topic || "Today's class"} has been marked as a holiday. Reason: ${reason}`,
            course_id: session.course_id,
            type: "holiday",
          },
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        );

        announcement = announcementResponse.data;
      } catch (announcementError) {
        console.warn(
          "Failed to create holiday announcement:",
          announcementError.response?.data || announcementError.message
        );
      }
    }

    return res.json({
      success: true,
      message: "Session marked as holiday",
      session_id: session.id,
      replacement_session_id: replacementSession?.id || null,
      announcement_id: announcement?.id || null,
    });
  } catch (error) {
    console.error("Holiday error:", error.response?.data || error.message);

    return res.status(error.response?.status || 500).json({
      success: false,
      error:
        error.response?.data?.message ||
        error.response?.data?.error ||
        error.message ||
        "Failed to mark session as holiday",
      details: error.response?.data || null,
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
      success_url: successUrl || "https://live.nextgenusmlelms.com/payment-success",
      cancel_url: cancelUrl || "https://live.nextgenusmlelms.com/payment-cancel",
    });

    res.json({
      url: session.url,
    });
  } catch (err) {
    console.error("Stripe Error:", err.response?.data || err.message);

    res.status(500).json({
      error: err.message,
    });
  }
});

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
    const {
      topic,
      start_time,
      duration,
      timezone = "America/New_York",
    } = req.body;

    const accessToken = await getZoomAccessToken();

    const response = await axios.post(
      "https://api.zoom.us/v2/users/me/meetings",
      {
        topic,
        type: 2,
        start_time,
        duration,
        timezone,
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

    res.json({
      signature,
    });
  } catch (error) {
    console.error("Signature Error:", error.response?.data || error.message);

    res.status(500).json({
      error: error.message,
    });
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
      const recordingFiles = recordingObject.recording_files || [];

      const videoFile =
        recordingFiles.find((file) => file.file_type === "MP4") ||
        recordingFiles[0];

      console.log("Recording completed:");
      console.log("Meeting ID:", String(recordingObject.id));
      console.log("Zoom UUID:", recordingObject.uuid);
      console.log("Topic:", recordingObject.topic);
      console.log("Start Time:", recordingObject.start_time);
      console.log("Duration:", recordingObject.duration);
      console.log(
        "Recording URL:",
        videoFile?.play_url || recordingObject.share_url || videoFile?.download_url || null
      );

      return res.status(200).json({
        received: true,
        saved: false,
        note: "Recording received. Recordings are fetched directly from Zoom via /zoom/recordings.",
      });
    }

    return res.status(200).json({
      received: true,
    });
  } catch (error) {
    console.error("Zoom webhook error:", error.response?.data || error.message);

    return res.status(200).json({
      success: false,
      error: error.response?.data || error.message,
    });
  }
});

app.get("/zoom/recordings", async (req, res) => {
  try {
    const accessToken = await getZoomAccessToken();

    const today = new Date();
    const to = today.toISOString().slice(0, 10);

    const fromDate = new Date();
    fromDate.setDate(today.getDate() - 30);
    const from = fromDate.toISOString().slice(0, 10);

    const response = await axios.get(
      `https://api.zoom.us/v2/users/me/recordings?from=${from}&to=${to}&page_size=100`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    const meetings = response.data?.meetings || [];

    const recordings = meetings.flatMap((meeting) => {
      const files = meeting.recording_files || [];

      return files
        .filter((file) => file.file_type === "MP4")
        .map((file) => ({
          meeting_id: String(meeting.id),
          uuid: meeting.uuid,
          topic: meeting.topic,
          start_time: meeting.start_time,
          duration: meeting.duration,
          share_url: meeting.share_url,
          recording_url: file.play_url || meeting.share_url || file.download_url,
          download_url: file.download_url,
          file_type: file.file_type,
          recording_type: file.recording_type,
          status: file.status,
        }));
    });

    return res.json({
      success: true,
      from,
      to,
      count: recordings.length,
      recordings,
    });
  } catch (error) {
    console.error("Zoom recordings fetch error:", error.response?.data || error.message);

    return res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
    });
  }
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
