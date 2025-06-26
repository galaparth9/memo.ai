const { MoleculerError } = require("moleculer").Errors;
const jwt = require("jsonwebtoken");
const { resolve } = require("path");
require('dotenv').config();
const Nodemailer = require('nodemailer');
const pdfParse = require('pdf-parse');

const EmailConfig = {
    host: process.env.senderEmailHost,
    port: process.env.senderEmailPort,
    service: process.env.senderEmailservice,
    secure: true,
    auth: {
        user: process.env.senderEmail,
        pass: process.env.senderEmailPass
    }
}
const generateResponse = (statusCode, message, data = null, withToken, token) => {
    const responseObject = {
        status: statusCode,
        message
    }

    if (data != null) {
        responseObject.data = data;
        if (withToken) {
            responseObject.data.token = token || generateJWT(data);
        }
    }



    return responseObject;
}

const generateJWT = (user) => {
    return jwt.sign({
        ...user,
        expiresIn: process.env.JWT_EXPIRY || "1800s"
    }, process.env.JWT_SECRET);
}

const generateOtp = (length = 4) => {
    const digits = '123456789';
    let otp = '';
    for (let i = 0; i < length; i++) {
        const randomIndex = Math.floor(Math.random() * digits.length);
        otp += digits[randomIndex];
    }
    return otp;
}

const getFileBuffer = async (ctx) => {
    const fileBuffer = [];

    return new Promise((resolve, reject) => {
        // Read the data from the incoming stream and accumulate it in the buffer
        ctx.params.on('data', (chunk) => {
            fileBuffer.push(chunk);
        });

        ctx.params.on('end', () => {
            // The 'end' event has completed, resolve the promise
            const finalBuffer = Buffer.concat(fileBuffer);
            resolve(finalBuffer);
        });

        ctx.params.on('error', (error) => {
            // Handle any errors that occur during the 'end' event
            reject(error);
        });
    });
}

const convertKeysToSnakeCase = (obj, keysToSkip = []) => {
    const snakeCaseObj = {};

    for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
            if (keysToSkip.includes(key)) {
                snakeCaseObj[key] = obj[key];
            } else {
                const snakeCaseKey = key.replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`);
                snakeCaseObj[snakeCaseKey] = obj[key];
            }
        }
    }

    return snakeCaseObj;
}

const convertSnakeCaseKeyToCamelCase = (obj, keysToSkip = []) => {
    const camelCaseObj = {};

    for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
            if (keysToSkip.includes(key)) {
                camelCaseObj[key] = obj[key];
            } else {
                const words = key.split('_');
                const camelCaseKey = words[0] + words.slice(1).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join('');
                camelCaseObj[camelCaseKey] = obj[key];
            }
        }
    }

    return camelCaseObj;
}


const sendEmail = (mailOptions) => {
    return new Promise(async (resolve, reject) => {
        const transporter = Nodemailer.createTransport(EmailConfig);

        let error = null;

        const response = await transporter.sendMail(mailOptions).catch(async (err) => {
            error = err.message;
            return null;
        });

        if (!response && error !== null) {
            reject({ status: false, message: 'Error in sending Email', error });
        }
        resolve({ status: true, message: 'Email Send' });
    });
}

const generateAlphanumericOTP = (length) => {
    const characters = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    let otp = '';

    for (let i = 0; i < length; i++) {
        const index = Math.floor(Math.random() * characters.length);
        otp += characters.charAt(index);
    }

    return otp;
}

const base64toBlob = async (base64Data) => {
    const mimeType = base64Data.match(/^data:([A-Za-z-+\/]+);base64,/);
    if (!mimeType) {
        throw new Error('Invalid base64 string');
    }

    const mimeTypeMatch = mimeType[1];
    const base64String = base64Data.split(';base64,').pop();
    const bufferData = Buffer.from(base64String, 'base64');

    // Extract file extension from MIME type
    const fileExtension = mimeTypeMatch.split('/').pop();

    return { bufferData, fileExtension, mimeTypeMatch };
}

const base64toPdfBuffer = async (base64Data) => {
    const pdfBuffer = Buffer.from(base64Data, 'base64');

    try {
        const pdfData = await pdfParse(pdfBuffer);

        const fileExtension = 'pdf';

        return { bufferData: pdfBuffer, fileExtension, mimeTypeMatch: 'application/pdf', pdfData };
    } catch (error) {
        throw new Error('Invalid base64 PDF string');
    }
}

module.exports = Object.assign({}, {
    EmailConfig,
    generateResponse,
    generateOtp,
    getFileBuffer,
    convertKeysToSnakeCase,
    convertSnakeCaseKeyToCamelCase,
    sendEmail,
    generateAlphanumericOTP,
    base64toBlob,
    base64toPdfBuffer
})