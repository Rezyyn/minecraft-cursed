#!/usr/bin/env node

/**
 * CurseForge Mod Manager
 * Integrates with CurseForge API to list, search, and download mods
 * Designed for use with AMP Generic Module
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

// Configuration
let config = {
    apiKey: '',
    gameId: 432, // Default to Minecraft
    baseUrl: 'https://api.curseforge.com',
    userAgent: 'AMP-CurseForge-Manager/1.0',
    modsDirectory: './mods/'
};

// Command line arguments parsing
const args = process.argv.slice(2);
const parsedArgs = {};

for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
        const [key, value] = arg.substring(2).split('=');
        if (value !== undefined) {
            parsedArgs[key] = value;
        } else {
            parsedArgs[key] = true;
        }
    }
}

// Apply command line arguments to config
Object.assign(config, {
    apiKey: parsedArgs.apikey || config.apiKey,
    gameId: parseInt(parsedArgs.gameid) || config.gameId,
    searchQuery: parsedArgs.search || '',
    categoryId: parsedArgs.categoryid ? parseInt(parsedArgs.categoryid) : undefined,
    modLoaderType: parsedArgs.modloader ? parseInt(parsedArgs.modloader) : undefined,
    gameVersion: parsedArgs.gameversion || '',
    sortField: parseInt(parsedArgs.sortfield) || 2,
    sortOrder: parsedArgs.sortorder || 'desc',
    pageSize: parseInt(parsedArgs.pagesize) || 20,
    autoDownload: parsedArgs.autodownload === 'true',
    modsDirectory: parsedArgs.modsdir || config.modsDirectory
});

// Utility Functions
function makeApiRequest(endpoint, options = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(endpoint, config.baseUrl);
        
        // Add query parameters
        Object.keys(options).forEach(key => {
            if (options[key] !== undefined && options[key] !== '') {
                url.searchParams.append(key, options[key]);
            }
        });

        const requestOptions = {
            method: 'GET',
            headers: {
                'x-api-key': config.apiKey,
                'Accept': 'application/json',
                'User-Agent': config.userAgent
            }
        };

        console.log(`Making API request to: ${url.toString()}`);

        const req = https.request(url, requestOptions, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                try {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        const jsonData = JSON.parse(data);
                        resolve(jsonData);
                    } else {
                        console.error(`API Error: HTTP ${res.statusCode}`);
                        console.error(`Response: ${data}`);
                        reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                    }
                } catch (error) {
                    console.error('Error parsing JSON response:', error.message);
                    reject(error);
                }
            });
        });

        req.on('error', (error) => {
            console.error('Request error:', error.message);
            reject(error);
        });

        req.setTimeout(30000, () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });

        req.end();
    });
}

function downloadFile(url, filePath) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const client = urlObj.protocol === 'https:' ? https : http;
        
        console.log(`Downloading: ${url}`);
        console.log(`Saving to: ${filePath}`);

        const request = client.get(url, (response) => {
            if (response.statusCode === 302 || response.statusCode === 301) {
                // Handle redirect
                return downloadFile(response.headers.location, filePath)
                    .then(resolve)
                    .catch(reject);
            }

            if (response.statusCode !== 200) {
                reject(new Error(`Download failed: HTTP ${response.statusCode}`));
                return;
            }

            const fileSize = parseInt(response.headers['content-length'] || '0');
            let downloadedSize = 0;

            // Ensure directory exists
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            const fileStream = fs.createWriteStream(filePath);

            response.on('data', (chunk) => {
                downloadedSize += chunk.length;
                if (fileSize > 0) {
                    const progress = Math.round((downloadedSize / fileSize) * 100);
                    process.stdout.write(`\rProgress: ${progress}% (${downloadedSize}/${fileSize} bytes)`);
                }
            });

            response.pipe(fileStream);

            fileStream.on('finish', () => {
                console.log(`\nDownload completed: ${path.basename(filePath)}`);
                resolve(filePath);
            });

            fileStream.on('error', (error) => {
                fs.unlink(filePath, () => {}); // Clean up partial file
                reject(error);
            });
        });

        request.on('error', reject);
        request.setTimeout(60000, () => {
            request.destroy();
            reject(new Error('Download timeout'));
        });
    });
}

// API Functions
async function searchMods() {
    try {
        const params = {
            gameId: config.gameId,
            pageSize: config.pageSize,
            sortField: config.sortField,
            sortOrder: config.sortOrder
        };

        // Add optional filters
        if (config.searchQuery) params.searchFilter = config.searchQuery;
        if (config.categoryId) params.categoryId = config.categoryId;
        if (config.modLoaderType && config.modLoaderType !== 0) params.modLoaderType = config.modLoaderType;
        if (config.gameVersion) params.gameVersion = config.gameVersion;

        const response = await makeApiRequest('/v1/mods/search', params);
        
        if (response.data && response.data.length > 0) {
            console.log(`\nFound ${response.data.length} mods:`);
            console.log('='.repeat(80));

            response.data.forEach((mod, index) => {
                console.log(`${index + 1}. ${mod.name} (ID: ${mod.id})`);
                console.log(`   Author(s): ${mod.authors.map(a => a.name).join(', ')}`);
                console.log(`   Downloads: ${mod.downloadCount.toLocaleString()}`);
                console.log(`   Summary: ${mod.summary}`);
                console.log(`   Categories: ${mod.categories.map(c => c.name).join(', ')}`);
                
                if (mod.latestFiles && mod.latestFiles.length > 0) {
                    const latestFile = mod.latestFiles[0];
                    console.log(`   Latest File: ${latestFile.displayName} (${latestFile.fileName})`);
                    console.log(`   Game Versions: ${latestFile.gameVersions.join(', ')}`);
                }
                
                console.log('   ' + '-'.repeat(60));
            });

            console.log(`\nStats: ${response.data.length} mods found, 0 downloaded`);

            // Auto-download if enabled
            if (config.autoDownload) {
                console.log('\nAuto-download is enabled. Starting downloads...');
                let downloadCount = 0;
                
                for (const mod of response.data) {
                    if (mod.latestFiles && mod.latestFiles.length > 0) {
                        try {
                            await downloadMod(mod.id);
                            downloadCount++;
                        } catch (error) {
                            console.error(`Failed to download mod ${mod.name}: ${error.message}`);
                        }
                    }
                }
                
                console.log(`\nStats: ${response.data.length} mods found, ${downloadCount} downloaded`);
            }

        } else {
            console.log('No mods found matching your criteria.');
        }

        if (response.pagination) {
            console.log(`\nPagination: Showing ${response.pagination.resultCount} of ${response.pagination.totalCount} total results`);
        }

    } catch (error) {
        console.error('Error searching mods:', error.message);
        process.exit(1);
    }
}

async function getModInfo(modId) {
    try {
        console.log(`Fetching information for mod ID: ${modId}`);
        
        const response = await makeApiRequest(`/v1/mods/${modId}`);
        
        if (response.data) {
            const mod = response.data;
            console.log('\n' + '='.repeat(80));
            console.log(`MOD INFORMATION`);
            console.log('='.repeat(80));
            console.log(`Name: ${mod.name}`);
            console.log(`ID: ${mod.id}`);
            console.log(`Slug: ${mod.slug}`);
            console.log(`Author(s): ${mod.authors.map(a => a.name).join(', ')}`);
            console.log(`Summary: ${mod.summary}`);
            console.log(`Downloads: ${mod.downloadCount.toLocaleString()}`);
            console.log(`Featured: ${mod.isFeatured ? 'Yes' : 'No'}`);
            console.log(`Categories: ${mod.categories.map(c => c.name).join(', ')}`);
            console.log(`Created: ${new Date(mod.dateCreated).toLocaleDateString()}`);
            console.log(`Modified: ${new Date(mod.dateModified).toLocaleDateString()}`);
            
            if (mod.links) {
                console.log(`Website: ${mod.links.websiteUrl || 'N/A'}`);
                console.log(`Wiki: ${mod.links.wikiUrl || 'N/A'}`);
                console.log(`Issues: ${mod.links.issuesUrl || 'N/A'}`);
                console.log(`Source: ${mod.links.sourceUrl || 'N/A'}`);
            }

            if (mod.latestFiles && mod.latestFiles.length > 0) {
                console.log('\nLatest Files:');
                mod.latestFiles.forEach((file, index) => {
                    console.log(`  ${index + 1}. ${file.displayName} (${file.fileName})`);
                    console.log(`     File ID: ${file.id}`);
                    console.log(`     Size: ${(file.fileLength / (1024 * 1024)).toFixed(2)} MB`);
                    console.log(`     Downloads: ${file.downloadCount.toLocaleString()}`);
                    console.log(`     Game Versions: ${file.gameVersions.join(', ')}`);
                    console.log(`     Release Date: ${new Date(file.fileDate).toLocaleDateString()}`);
                });
            }

        } else {
            console.log('Mod not found.');
        }

    } catch (error) {
        console.error('Error fetching mod info:', error.message);
        process.exit(1);
    }
}

async function downloadMod(modId) {
    try {
        console.log(`Downloading mod ID: ${modId}`);
        
        // First get mod info
        const modResponse = await makeApiRequest(`/v1/mods/${modId}`);
        
        if (!modResponse.data) {
            throw new Error('Mod not found');
        }

        const mod = modResponse.data;
        
        if (!mod.latestFiles || mod.latestFiles.length === 0) {
            throw new Error('No files available for this mod');
        }

        // Get the latest file
        const latestFile = mod.latestFiles[0];
        console.log(`Latest file: ${latestFile.displayName} (${latestFile.fileName})`);

        // Get download URL
        const downloadResponse = await makeApiRequest(`/v1/mods/${modId}/files/${latestFile.id}/download-url`);
        
        if (!downloadResponse.data) {
            throw new Error('Could not get download URL');
        }

        const downloadUrl = downloadResponse.data;
        const fileName = latestFile.fileName;
        const filePath = path.join(config.modsDirectory, fileName);

        // Download the file
        await downloadFile(downloadUrl, filePath);
        
        // Save download info
        const downloadInfo = {
            modId: mod.id,
            modName: mod.name,
            fileId: latestFile.id,
            fileName: fileName,
            filePath: filePath,
            downloadDate: new Date().toISOString(),
            fileSize: latestFile.fileLength,
            gameVersions: latestFile.gameVersions
        };

        // Update downloaded mods list
        let downloadedMods = [];
        const downloadedFile = path.join(process.cwd(), 'downloaded-mods.json');
        
        if (fs.existsSync(downloadedFile)) {
            try {
                const existingData = fs.readFileSync(downloadedFile, 'utf8');
                downloadedMods = JSON.parse(existingData);
            } catch (error) {
                console.warn('Could not read downloaded-mods.json, creating new file');
            }
        }

        // Remove existing entry if present
        downloadedMods = downloadedMods.filter(item => item.modId !== mod.id);
        downloadedMods.push(downloadInfo);

        fs.writeFileSync(downloadedFile, JSON.stringify(downloadedMods, null, 2));
        console.log(`Download completed and logged: ${fileName}`);

    } catch (error) {
        console.error('Error downloading mod:', error.message);
        throw error;
    }
}

// Main function
async function main() {
    console.log('CurseForge Mod Manager started');
    console.log('==============================');

    // Validate API key
    if (!config.apiKey) {
        console.error('Error: CurseForge API key is required!');
        console.error('Please set the API key in the configuration.');
        process.exit(1);
    }

    // Display current configuration
    console.log(`Game ID: ${config.gameId}`);
    console.log(`Mods Directory: ${config.modsDirectory}`);
    
    if (config.searchQuery) console.log(`Search Query: "${config.searchQuery}"`);
    if (config.categoryId) console.log(`Category ID: ${config.categoryId}`);
    if (config.modLoaderType && config.modLoaderType !== 0) console.log(`Mod Loader: ${config.modLoaderType}`);
    if (config.gameVersion) console.log(`Game Version: ${config.gameVersion}`);
    
    console.log('');

    try {
        // Handle different actions
        if (parsedArgs.list || (!parsedArgs.download && !parsedArgs.info)) {
            await searchMods();
        } else if (parsedArgs.download) {
            const modId = parseInt(parsedArgs.download);
            if (isNaN(modId)) {
                console.error('Error: Invalid mod ID for download');
                process.exit(1);
            }
            await downloadMod(modId);
        } else if (parsedArgs.info) {
            const modId = parseInt(parsedArgs.info);
            if (isNaN(modId)) {
                console.error('Error: Invalid mod ID for info');
                process.exit(1);
            }
            await getModInfo(modId);
        }

        console.log('\nCurseForge Mod Manager completed successfully');

        // Update API status info for AMP monitoring
        console.log('API Status: Connected, Rate Limit: Unknown/Unknown');

    } catch (error) {
        console.error('Fatal error:', error.message);
        process.exit(1);
    }
}

// Signal handlers for graceful shutdown
process.on('SIGINT', () => {
    console.log('\nReceived SIGINT, shutting down gracefully...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\nReceived SIGTERM, shutting down gracefully...');
    process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error.message);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});

// Start the application
if (require.main === module) {
    main().catch((error) => {
        console.error('Application failed to start:', error.message);
        process.exit(1);
    });
}