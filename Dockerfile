FROM node:20-bullseye-slim

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Menyiapkan direktori kerja di dalam kontainer
WORKDIR /app

# Menyalin file konfigurasi package npm
COPY package*.json ./

# Menginstal dependensi
RUN npm install

# Menyalin seluruh sisa kode aplikasi
COPY . .

# Hugging Face Spaces WAJIB menggunakan port 7860
ENV PORT=7860
EXPOSE 7860

# Perintah untuk menjalankan bot
CMD ["node", "index.js"]
