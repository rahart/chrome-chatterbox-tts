const fs = require('fs');
const { createCanvas, loadImage } = require('canvas');
const sharp = require('sharp');
const path = require('path');

// Ensure the icons directory exists
const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

// Sizes needed for Chrome extension
const sizes = [16, 48, 128];

// Function to generate PNG icons from SVG
async function generateIcons() {
  try {
    const svgPath = path.join(iconsDir, 'icon.svg');
    
    // Check if the SVG exists
    if (!fs.existsSync(svgPath)) {
      console.error('SVG icon not found at:', svgPath);
      return;
    }
    
    console.log('Generating icons...');
    
    // Generate each size
    for (const size of sizes) {
      const outputPath = path.join(iconsDir, `icon${size}.png`);
      
      await sharp(svgPath)
        .resize(size, size)
        .png()
        .toFile(outputPath);
      
      console.log(`Generated ${size}x${size} icon at: ${outputPath}`);
    }
    
    console.log('Icon generation complete!');
  } catch (error) {
    console.error('Error generating icons:', error);
  }
}

// Run the generator
generateIcons();
