// const cloudinary = require("cloudinary").v2;
import cloudinary from "cloudinary"
import dotenv from "dotenv"

dotenv.config(); // Make sure you have dotenv installed and your .env file is set up

// Configure Cloudinary using environment variables for security
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true, // Use HTTPS for all URLs
});

export default cloudinary;
