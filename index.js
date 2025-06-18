import dotenv from "dotenv";
dotenv.config();
import express from "express";
import cors from "cors";
import { MongoClient, ServerApiVersion, ObjectId } from "mongodb";

const app = express();
const port = process.env.PORT || 5000;

// Request Logger Middleware
const requestLogger = (req, res, next) => {
  console.log("\n=== Request Details ===");
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  console.log("Headers:", req.headers);
  console.log("Query:", req.query);
  console.log("Body:", req.body);
  console.log("========================\n");
  next();
};

// Middleware Setup
app.use(requestLogger);
app.use(
  cors({
    origin: "*",
    
    methods: ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept"],
    credentials: false,
  })
);
app.use(express.json());

// MongoDB Setup
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.8puxff9.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// Authentication Middleware
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return res
        .status(401)
        .json({ error: "Unauthorized - No token provided" });
    }

    const token = authHeader.split(" ")[1];
    if (!token) {
      return res.status(401).json({ error: "Invalid token" });
    }

    try {
      // Decode JWT token
      const [header, payload, signature] = token.split(".");
      const decodedPayload = JSON.parse(
        Buffer.from(payload, "base64").toString()
      );

      if (!decodedPayload.email) {
        throw new Error("Invalid token structure");
      }

      req.user = {
        email: decodedPayload.email,
        displayName: decodedPayload.name || "Anonymous",
        photoURL: decodedPayload.picture || null,
      };

      next();
    } catch (tokenError) {
      console.error("Token decode failed:", tokenError);
      return res.status(401).json({ error: "Invalid token format" });
    }
  } catch (error) {
    console.error("Auth Error:", error);
    res.status(401).json({ error: "Authentication failed" });
  }
};

async function run() {
  try {
    const eventsCollection = client.db("socialEvents").collection("events");
    const usersCollection = client.db("socialEvents").collection("users");
    const joinedEventsCollection = client
      .db("socialEvents")
      .collection("joinedEvents");

    // User Management Endpoints
    app.post("/users", authenticate, async (req, res) => {
      try {
        const { displayName, photoURL, preferences } = req.body;

        const updateData = {
          email: req.user.email,
          displayName: displayName || req.user.displayName,
          photoURL: photoURL || req.user.photoURL,
          preferences: preferences || {
            notifications: true,
            emailUpdates: true,
          },
          updatedAt: new Date(),
        };

        const result = await usersCollection.updateOne(
          { email: req.user.email },
          { $set: updateData },
          { upsert: true }
        );

        const updatedUser = await usersCollection.findOne({
          email: req.user.email,
        });
        res.json(updatedUser);
      } catch (error) {
        console.error("Create/Update User Error:", error);
        res.status(500).json({ error: "Server error" });
      }
    });

    app.get("/users/:email", authenticate, async (req, res) => {
      try {
        if (req.params.email !== req.user.email) {
          return res
            .status(403)
            .json({ error: "Unauthorized - Can only access own profile" });
        }

        const user = await usersCollection.findOne({ email: req.params.email });
        if (!user) {
          return res.status(404).json({ error: "User not found" });
        }
        res.json(user);
      } catch (error) {
        console.error("Get User Error:", error);
        res.status(500).json({ error: "Server error" });
      }
    });

    // Events Endpoints
    app.get("/events", async (req, res) => {
      try {
        const { type, search, limit } = req.query;
        const query = { eventDate: { $gte: new Date() } }; // Only upcoming events

        if (type) query.eventType = type;
        if (search) query.title = { $regex: search, $options: "i" };

        const events = await eventsCollection
          .find(query)
          .limit(parseInt(limit) || 0)
          .sort({ eventDate: 1 })
          .toArray();


        const enrichedEvents = await Promise.all(
            events.map(async (event) => {
              const participants = await joinedEventsCollection
                  .find({ eventId: event._id })
                  .project({ _id: 0, userEmail: 1, userName: 1, userPhotoURL: 1 })
                  .toArray();

              return {
                ...event,
                participants,                  // full participant data
                participantsCount: participants.length,  // count only (optional)
              };
            })
        );

        res.json(enrichedEvents);
      } catch (error) {
        console.error("Get Events Error:", error);
        res.status(500).json({ error: "Server error" });
      }
    });

    app.get("/events/:id", async (req, res) => {
      try {
        const eventId = new ObjectId(req.params.id);

        // Find the event
        const event = await eventsCollection.findOne({ _id: eventId });

        if (!event) {
          return res.status(404).json({ error: "Event not found" });
        }

        // Get joined participants
        const participants = await joinedEventsCollection
            .find({ eventId: eventId })
            .project({ _id: 0, userEmail: 1, userName: 1, userPhotoURL: 1, joinedAt: 1 })
            .toArray();

        // Attach participants to the event object
        event.participants = participants;

        res.json(event);
      } catch (error) {
        console.error("Get Event Error:", error);
        res.status(500).json({ error: "Server error" });
      }
    });

    app.post("/events", authenticate, async (req, res) => {
      try {
        const {
          title,
          description,
          eventType,
          thumbnailImage,
          location,
          eventDate,
        } = req.body;

        if (!title || !description || !eventType || !location || !eventDate) {
          return res.status(400).json({ error: "Missing required fields" });
        }

        const event = {
          title,
          description,
          eventType,
          thumbnailImage,
          location,
          eventDate: new Date(eventDate),
          userEmail: req.user.email,
          userName: req.user.displayName,
          userPhotoURL: req.user.photoURL,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const result = await eventsCollection.insertOne(event);
        const insertedEvent = await eventsCollection.findOne({
          _id: result.insertedId,
        });

        // Automatically add creator to joined events

        const joinData = {
          eventId: insertedEvent._id,
          userEmail: req.user.email,
          userName: req.user.displayName,
          userPhotoURL: req.user.photoURL,
          joinedAt: new Date(),
        };

        await joinedEventsCollection.insertOne(joinData);
        res.status(201).json(insertedEvent);
      } catch (error) {
        console.error("Create Event Error:", error);
        res.status(400).json({ error: "Invalid data" });
      }
    });

    app.put("/events/:id", authenticate, async (req, res) => {
      try {
        const eventId = req.params.id;
        const {
          title,
          description,
          eventType,
          thumbnailImage,
          location,
          eventDate,
        } = req.body;

        const event = await eventsCollection.findOne({
          _id: new ObjectId(eventId),
        });
        if (!event) {
          return res.status(404).json({ error: "Event not found" });
        }

        if (event.userEmail !== req.user.email) {
          return res
            .status(403)
            .json({ error: "Unauthorized - Can only update own events" });
        }

        const updateData = {
          title: title || event.title,
          description: description || event.description,
          eventType: eventType || event.eventType,
          thumbnailImage: thumbnailImage || event.thumbnailImage,
          location: location || event.location,
          eventDate: eventDate ? new Date(eventDate) : event.eventDate,
          updatedAt: new Date(),
        };

        const result = await eventsCollection.findOneAndUpdate(
          { _id: new ObjectId(eventId) },
          { $set: updateData },
          { returnDocument: "after" }
        );

        res.json(result.value);
      } catch (error) {
        console.error("Update Event Error:", error);
        res.status(500).json({ error: "Server error" });
      }
    });

    // Join Event Endpoints
    app.post("/events/:id/join", authenticate, async (req, res) => {
      try {
        const eventId = req.params.id;
        const event = await eventsCollection.findOne({
          _id: new ObjectId(eventId),
        });

        if (!event) {
          return res.status(404).json({ error: "Event not found" });
        }

        // Check if user already joined
        const existingJoin = await joinedEventsCollection.findOne({
          eventId: new ObjectId(eventId),
          userEmail: req.user.email,
        });

        if (existingJoin) {
          return res.status(406).json({ error: "Already joined this event" });
        }

        const joinData = {
          eventId: new ObjectId(eventId),
          userEmail: req.user.email,
          userName: req.user.displayName,
          userPhotoURL: req.user.photoURL,
          joinedAt: new Date(),
        };

        await joinedEventsCollection.insertOne(joinData);
        res.status(201).json({ message: "Successfully joined event" });
      } catch (error) {
        console.error("Join Event Error:", error);
        res.status(500).json({ error: "Server error" });
      }
    });

    app.get("/joined/events", authenticate, async (req, res) => {
      try {
        const joinedEvents = await joinedEventsCollection
          .find({ userEmail: req.user.email })
          .sort({ joinedAt: -1 })
          .toArray();

        const eventIds = joinedEvents.map((join) => join.eventId);
        const events = await eventsCollection
          .find({ _id: { $in: eventIds } })
          .sort({ eventDate: 1 })
          .toArray();

        res.json(events);
      } catch (error) {
        console.error("Get Joined Events Error:", error);
        res.status(500).json({ error: "Server error" });
      }
    });

    // app.get("/events/joined", authenticate, async (req, res) => {
    //   try {
    //     // Get all joined events for the user
    //     const joinedEvents = await joinedEventsCollection
    //       .find({ userEmail: req.user.email })
    //       .sort({ joinedAt: -1 })
    //       .toArray();
    
    //     // Convert eventIds to ObjectId
    //     const eventIds = joinedEvents.map((join) => {
    //       try {
    //         return new ObjectId(join.eventId);
    //       } catch (error) {
    //         console.error("Invalid ObjectId:", join.eventId);
    //         return null;
    //       }
    //     }).filter(id => id !== null);
    
    //     if (eventIds.length === 0) {
    //       return res.json([]);
    //     }
    
    //     // Get the events
    //     const events = await eventsCollection
    //       .find({ _id: { $in: eventIds } })
    //       .sort({ eventDate: 1 })
    //       .toArray();
    
    //     // Enrich events with participant data
    //     const enrichedEvents = await Promise.all(
    //       events.map(async (event) => {
    //         const participants = await joinedEventsCollection
    //           .find({ eventId: event._id })
    //           .project({ _id: 0, userEmail: 1, userName: 1, userPhotoURL: 1 })
    //           .toArray();
    
    //         return {
    //           ...event,
    //           participants,
    //           participantsCount: participants.length,
    //           isJoined: true
    //         };
    //       })
    //     );
    
    //     res.json(enrichedEvents);
    //   } catch (error) {
    //     console.error("Get Joined Events Error:", error);
    //     res.status(500).json({ error: "Server error" });
    //   }
    // }); 

    app.get("/manage/events", authenticate, async (req, res) => {
      try {
        const events = await eventsCollection
          .find({ userEmail: req.user.email })
          .sort({ eventDate: 1 })
          .toArray();

        const enrichedEvents = await Promise.all(
            events.map(async (event) => {
              const participants = await joinedEventsCollection
                  .find({ eventId: event._id })
                  .project({ _id: 0, userEmail: 1, userName: 1, userPhotoURL: 1 })
                  .toArray();

              return {
                ...event,
                participants,                  // full participant data
                participantsCount: participants.length,  // count only (optional)
              };
            })
        );

        res.json(enrichedEvents);
      } catch (error) {
        console.error("Get Managed Events Error:", error);
        res.status(500).json({ error: "Server error" });
      }
    });

    // Root endpoint
    app.get("/", (req, res) => {
      res.send("Social Events Platform Server is Running");
    });

    console.log("Connected to MongoDB!");
  } catch (error) {
    console.error("Server Error:", error);
  }
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Error:", err);
  res.status(err.status || 500).json({
    error: err.message || "Internal server error",
  });
});

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

run().catch(console.dir);
