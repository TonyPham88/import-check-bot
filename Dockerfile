FROM node:20-slim

# Cài Python và pip
RUN apt-get update && apt-get install -y python3 python3-pip && rm -rf /var/lib/apt/lists/*

# Cài pdfplumber
RUN pip3 install pdfplumber --break-system-packages

WORKDIR /app

# Copy và cài Node packages
COPY package.json ./
RUN npm install

# Copy code
COPY . .

EXPOSE 3000

CMD ["node", "bot.js"]
