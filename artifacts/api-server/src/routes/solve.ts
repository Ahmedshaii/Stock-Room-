import { Router, type IRouter } from "express";

const router: IRouter = Router();

router.post("/solve", async (req, res) => {
  const problem = req.body?.problem;

  if (typeof problem !== "string" || !problem.trim()) {
    return res.status(400).json({ error: "Please describe your problem." });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(503).json({ error: "AI service is not configured." });
  }

  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: problem.trim() }] }],
        }),
      },
    );

    const data = await response.json() as any;

    if (!response.ok) {
      console.error("Gemini API error:", response.status, data.error?.message);
      return res.status(502).json({ error: "AI provider request failed." });
    }

    const answer = data.candidates?.[0]?.content?.parts
      ?.map((part: any) => part.text ?? "")
      .join("");

    if (!answer) {
      return res.status(502).json({ error: "AI returned no answer." });
    }

    return res.json({ success: true, answer });
  } catch (error) {
    console.error("AI request failed:", error);
    return res.status(502).json({ error: "AI service is temporarily unavailable." });
  }
});

export default router;
