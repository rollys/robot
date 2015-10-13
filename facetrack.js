/*
 * Copyright (c) 2015, Intel Corporation.
 *
 * This program is licensed under the terms and conditions of the 
 * Apache License, version 2.0.  The full text of the Apache License is at
 * http://www.apache.org/licenses/LICENSE-2.0
 *
*/
var cv = require('opencv'),
    io = require('socket.io')({
        path: '/' + require('path').basename(__dirname) + '/socket.io'
    }).listen(6789),
    ir = require('irobot'),
    fs = require('fs'),
    mraa = require('mraa');
var cam = new cv.VideoCapture(0);
cam.setWidth(320);
cam.setHeight(240);

var led = null;
try {
	led = new mraa.Gpio(23);
	led.dir(mraa.DIR_OUT);
} catch (err) {
	console.log('Unable to connect to GPIO. Do you have permissions?');
}

var sockets = [];

var FOV = 68.5, /* Microsoft HD LiveCam is 68.5deg diagonal FOV */
    FOV_x = FOV * Math.cos (Math.atan2(240, 320)) * 0.5; /* FOV along width */

var moving = { left: 0, right: 0 },
    lastCommand = 0,
    noFace = 0;

/* Increase this to make the robot move faster */
var speedMultiplier = 5;

function detectFacesAndTrack(err, image) {
    var faces = [];
    image.detectObject(cv.FACE_CASCADE, {}, function (err, faces) {
        if (err) {
            throw err;
        }
        var largest = -1;
        
        faces.forEach(function (face, i) {
            /* Remap x and y properties to left and top */
            face.left = face.x;
            delete face.x;
            face.top = face.y;
            delete face.y;
            faces[i].size = face.width * face.height;

            if (largest == -1 || faces[i].size > faces[largest].size) {
                largest = i;
            }
        });
        
        updatePlan({face: largest == -1 ? null : faces[largest]});

        if (largest != -1) {
            faces[largest].largest = true;
        }
        
        io.emit('frame', {
            image: image.toBuffer(),
            faces: faces
        });
        
        cam.read(detectFacesAndTrack);
    });
}

function requestLED(state) {
    if (led) {
        led.write(state ? 0 : 1);
    }
}

function requestSpeed(left, right) {
    if (!robot || !robot.ready) {
        return;
    }
    
   /* Validate requested speeds make sense given current sensor wall and
    * cliff values, adjust accordingly */

   /* Send the new speed values to the robot */
   robot.drive({left: Math.round(left), right: Math.round(right)});
}

function updatePlan(update) {
    if ('face' in update) { /* face update */
        var now = Date.now();
        if (!update.face) {
            if (++noFace == 5) {
                console.log('Faces for ' + noFace + ' frames. Stopping robot.');
                requestSpeed(0, 0); /* TODO: Switch into SEEK mode */
                requestLED(0); /* Turn OFF 'face detected' LED */
            }
            return;
        }

        /* We detected a face, so keep moving for at least 5 sequential frames... */
        noFace = 0;
        
        requestLED(1); /* Turn ON 'face detected' LED */
 
        /* calculate how far 'face' is from center of image and determeine 
         * optimal motor speeds to move robot in direction to center face */
        var face = update.face;
        var deltaAngle = FOV_x * ((face.left + face.width / 2) / (320 / 2) - 1),
            framePos = (face.top + face.height / 2) / ((240 - face.height) / 2) - 1,
            rotateSpeed = Math.pow(deltaAngle / FOV_x, 2);
        var left = 0, right = 0;
        
        if (deltaAngle < 0) {
            console.log('Rotate left ' + Math.round(deltaAngle * 10) / 10 + 'deg');
            left = 100 * rotateSpeed;
            right = -100 * rotateSpeed;
        } else {
            console.log('Rotate right ' + Math.round(deltaAngle * 10) / 10 + 'deg');
            left = -100 * rotateSpeed;
            right = 100 * rotateSpeed;
        }

        if (Math.abs(framePos) < 1 && Math.abs(framePos) > 0.15) {
            var direction = framePos < 0 ? -1 : +1;
            left += direction * 40;
            right += direction * 40;
            console.log('Drive ' + (direction < 0 ? 'backward' : 'forward'));
        } 

        requestSpeed(left * speedMultiplier, right * speedMultiplier);

        noFace = 0;
    } else if ('sensors' in update) {
    }
}

var robot;
try {
    var stats = fs.statSync('/dev/ttyUSB0');
    /* The documentation states a baud rate of 57600, however using a logic 
     * analyzer, I found that communication was occurring at 115200 baud */
    robot = new ir.Robot('/dev/ttyUSB0', {
        baudrate: 115200
    });

    robot.on('ready', function () {
        console.log('READY');
        robot.ready = true;
        lastCommand = Date.now();
        // Once the robot is ready, start face detection tracking
        cam.read(detectFacesAndTrack);
     });
    
    robot.on('sensordata', function() {
        var data = robot.getSensorData();
        updatePlan({sensors: data});
        if (Object.getOwnPropertyNames(data).length > 0) {
            io.emit('sensordata', robot.getSensorData());
        }
    });
} catch (err) {
    console.log('No robot found at /dev/ttyUSB0. Continuing without robot.');
    robot = null;
    cam.read(detectFacesAndTrack);
}

io.on('connection', function(_socket) {
    sockets.push(_socket);
    console.log('CONNECT');

    _socket.on('disconnect', function() {
        console.log('DISCONNECT');
        /* Remove this socket from the list of active sockets */
        sockets = sockets.filter(function(socket) {
            return (_socket != socket);
        });
        console.log(sockets.length + ' connections remain.');
    });
    
    /* If we have a robot connection, send the sensor data
     * to the new socket */
    if (robot) {
       var data = robot.getSensorData();
       if (Object.getOwnPropertyNames(data).length > 0) {
           _socket.emit('sensordata', robot.getSensorData());
       }
    }
});
