import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Stripe from "stripe";

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
  res.send("Stripe backend running");
});

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

app.listen(5000, () => {
  console.log("Server running on port 5000");
});
