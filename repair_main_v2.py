import sys

target_file = r'c:\Users\Chirag\Documents\3d_play\main.js'

with open(target_file, 'r', encoding='utf-8') as f:
    content = f.read()

# Find the corruption point
broken_block = '''gear_gap = 1;
gear_min_gap = 0.1;
gear_hold_R = 4;
epsilonCSG = 0.1;
$fn=12;
DEBUG_GEARS = (HIGH_DETAIL_GEARS == 1) ? 0 : 1;

	//mirror([0,0,1])
	translate([teethHolderW+maxTeethL,0,0])

	rotate([180,0,0])
	for (x = [0:pinNrX-1])
	{
		assign(ll = TeethLen(x))
		{
			translate([-maxTeethL, x *pinStepX + teethGap, 0]) 
			{
				// teeth holder
				assign (leftAdd = (x == 0) ? gearBoxW : 0, rightAdd = (x == pinNrX-1) ? wall/2+gear_gap : 0)
				{
				translate([-(teethHolderW), epsilonCSG-leftAdd, 0]) 
					cube([teethHolderW+maxTeethL-ll, pinStepX+2*epsilonCSG+leftAdd+rightAdd, teethHolderH]);
				}
				

				// teeth
				translate([-teethHolderW/2, teethGap,0])
				color([0,1,0])cube([maxTeethL+teethHolderW/2, teethW, teethH]);
			}
		}
	}
	
}'''

restored_block = r'''gear_gap = 1;
gear_min_gap = 0.1;
gear_hold_R = 4;

// used for clean CSG operations
epsilonCSG = 0.1;
// reduce this for faster previews
$fn=12;
// Replace Gears with Cylinders to verify gear alignment
DEBUG_GEARS = (HIGH_DETAIL_GEARS == 1) ? 0 : 1;


crankAxisR = 3;
crankAxisCutAway = crankAxisR*0.8;
crankLength = 18;
crankAxisCutAwayH = 4;

crankExtraH=4;
crankH=crankExtraH+2*crankAxisCutAwayH;


pulleyH=10;
pulleyR=crankAxisR+wall;


/// music section
teethH = 3*0.3;
pinH= 3;
pteethMinD = 1.5;
teethGap = pinH;
pinD=1.5;
teethHolderW=5;
teethHolderH=5;

circular_pitch = 180/diametral_pitch;
addendum = 1/diametral_pitch;
musicH=pinNrX*(wall+teethGap);

echo("height of song cylinder");
echo(musicH);

pinStepX = musicH/pinNrX;
pinStepY = 360/pinNrY;

teethW = pinStepX-teethGap;
maxTeethL=TeethLen(0); 

musicCylinderR = (musicCylinderTeeth/diametral_pitch)/2;
midSmallR = (midSmallTeeth/diametral_pitch)/2;
midBigR = (midBigTeeth/diametral_pitch)/2;
crankR = (crankTeeth/diametral_pitch)/2;

centerForCrankGearInsertion=(midBigR+crankR)/2;

noteExtend = teethHolderW+maxTeethL + pteethMinD; 

midGearDist = musicCylinderR+midSmallR;
crankDist = midBigR+crankR;

midGearXPos = cos(midGearAngle)*midGearDist;
midGearZPos = sin(midGearAngle)*midGearDist;

crankGearXPos = midGearXPos + cos(crankGearAngle)*crankDist;
crankGearZPos = midGearZPos + sin(crankGearAngle)*crankDist;

echo("R of song cylinder");
echo(musicCylinderR);
maxMusicAddendum = 1.5*max(addendum, pinH);
frameH = max(musicCylinderR, -midGearZPos+midBigR) + maxMusicAddendum;

gearBoxW = 2 * (gearH+gear_gap+wall) + gear_gap;


songH = musicH+teethGap+teethGap;
frameW = gearBoxW + songH;

noteExtendY = sin(noteAlpha)*noteExtend;
noteExtendX = cos(noteAlpha)*noteExtend;
echo(noteExtendY/musicCylinderR);
noteBeta = asin(noteAlpha ? noteExtendY/musicCylinderR : 0);

echo("Note Extend");
echo(noteExtendX);

musicCylinderRX = cos(noteBeta)*musicCylinderR;

negXEnd = -(noteExtendX+musicCylinderRX);
posXEnd = crankGearXPos + crankR + 1.5*addendum + wall;

posYEnd = tan(noteAlpha)*(noteExtendX + musicCylinderRX+posXEnd);


module MyAxisSnapCutout(h, z=0, mirr=0,extra=epsilonCSG)
{
	translate([0,0,z])
	mirror([0,0,mirr])
	translate([0,0,-extra]) 
	{	
		cylinder(h=h+extra+snapAxisSlack, r1=h+extra+snapAxisSlack, r2=0, center=false);
	}
}


module MyAxisSnapHolder(h, x=0, y=0, z=0, mirr=0,extra=wall, h2=0)
{
	rotate([-90,0,0])
	mirror([0,0,mirr])
	translate([x,-z,-extra-y]) 
	{
		cylinder(h=h+extra, r1=h+extra, r2=0, center=false);
		intersection()
		{
			cylinder(h=h+extra+gear_hold_R, r1=h+extra+gear_hold_R, r2=0, center=false);
			translate([0, 0, -50 + extra -gear_min_gap])
				cube([100, 100, 100], center=true);
		}
	}
}

module MyGear(n, hPos, hNeg, mirr=0)
{
	if (DEBUG_GEARS)
	{
		translate([0,0,-hNeg]) cylinder(r=(n/diametral_pitch)/2, h=hPos+hNeg, center = false);
	}
	if (!DEBUG_GEARS)
	{
		HBgearWithDifferentLen(n=n, mirr=mirr, hPos=hPos, hNeg=hNeg, tol=gear_tolerance);
	}
}


module HBgearWithDifferentLen(n,hPos,hNeg,mirr=0, tol=0.25)
{
twistScale=50;
mirror([mirr,0,0])
translate([0,0,0])
union(){
	mirror([0,0,1])
	gear(number_of_teeth=n,
		diametral_pitch=diametral_pitch,
		gear_thickness=hNeg,
		rim_thickness=hNeg,
		hub_thickness=hNeg,
		bore_diameter=0,
		backlash=2*tol,
		clearance=2*tol,
		pressure_angle=20,
		twist=hNeg*twistScale/n,
		slices=5);
	
	gear(number_of_teeth=n,
		diametral_pitch=diametral_pitch,
		gear_thickness=hPos,
		rim_thickness=hPos,
		hub_thickness=hPos,
		bore_diameter=0,
		backlash=2*tol,
		clearance=2*tol,
		pressure_angle=20,
		twist=hPos*twistScale/n,
		slices=5);
}
}


echo("Testing NoteToFrequ, expected freq is 440");
echo(NoteToFrequ(9, 4, 0));


function TeethLen(x) = 
	1000*LengthOfTooth(NoteToFrequ(LetterToNoteIndex(teethNotes[x*3]), 
			LetterToDigit(teethNotes[x*3+2]),
			AccidentalToNoteShift(teethNotes[x*3+1])),
			teethH/1000, E_PLA, ro_PLA);

function LengthOfTooth(f, h, E, ro) = sqrt((gammaTooth*gammaTooth*h/(4*PI*f))*sqrt(E/(3*ro)));

function NoteToFrequ(note, octave, modification) = baseFrequC0*pow(2, octave)*pow(2, (note+modification)/12);

function AccidentalToNoteShift(l) =
l=="#"?1:
l=="b"?-1:
l==" "?0:
INVALID_ACCIDENTAL_CHECK_teethNotes();

function LetterToNoteIndex(l) =
l=="C"?0:
l=="D"?2:
l=="E"?4:
l=="F"?5:
l=="G"?7:
l=="A"?9:
l=="H"?11:
l=="B"?11: 
INVALID_NOTE_CHECK_teethNotes();

function LetterToDigit(l) = 
l=="0"?0:
l=="1"?1:
l=="2"?2:
l=="3"?3:
l=="4"?4:
l=="5"?5:
l=="6"?6:
l=="7"?7:
l=="8"?8:
l=="9"?9:
INVALID_DIGIT_IN_OCTAVE_CHECK_teethNotes();


module Pin()
{
	// Simplified for web performance: single cube instead of difference
	translate([-pinStepX/2,-pinD/2,-pinH])
	cube([pinStepX+teethGap, pinD, pinH],center=false);
}



module MusicCylinder(extra=0)
{
	translate([0,0,-extra]) cylinder(r = musicCylinderR, h = teethGap+musicH+extra, center=false, $fn=32);
	translate([0,0,teethGap])
	if (SHOW_PINS) {
		// Divide and conquer union for performance
		for (group_y = [0 : floor((pinNrY-1)/10)]) {
			union() {
				for (y = [group_y*10 : min(group_y*10+9, pinNrY-1)]) {
					for (x = [0:pinNrX-1]) {
						assign(index = y*pinNrX + x) {
							if (pins[index] == "X") {
								rotate([0,0, y * pinStepY])
								translate([musicCylinderR, 0, (0.5+x)*pinStepX]) rotate([0,90,0])
								Pin();
							}
						}
					}
				}
			}
		}
	}
}



module MusicBox()
{
	//mirror([0,0,1])
	translate([teethHolderW+maxTeethL,0,0])

	rotate([180,0,0])
	for (x = [0:pinNrX-1])
	{
		assign(ll = TeethLen(x))
		{
			translate([-maxTeethL, x *pinStepX + teethGap, 0]) 
			{
				// teeth holder
				assign (leftAdd = (x == 0) ? gearBoxW : 0, rightAdd = (x == pinNrX-1) ? wall/2+gear_gap : 0)
				{
				translate([-(teethHolderW), epsilonCSG-leftAdd, 0]) 
					cube([teethHolderW+maxTeethL-ll, pinStepX+2*epsilonCSG+leftAdd+rightAdd, teethHolderH]);
				}
				

				// teeth
				translate([-teethHolderW/2, teethGap,0])
				color([0,1,0])cube([maxTeethL+teethHolderW/2, teethW, teethH]);
			}
		}
	}
	
}'''

# Since simple replace might fail due to tabs/spaces, we find the core content
if restored_block in content:
    print("Already restored")
    sys.exit(0)

# Search for the start and end of the broken section
start_marker = "gear_gap = 1;"
end_marker = "mirror ([0, FOR_PRINT?crankDirection:0,0])"

start_idx = content.find(start_marker)
end_idx = content.find(end_marker)

if start_idx != -1 and end_idx != -1:
    new_content = content[:start_idx] + restored_block + "\n\n\n///// CODE\n\n\n" + content[end_idx:]
    with open(target_file, 'w', encoding='utf-8') as f:
        f.write(new_content)
    print("Repair successful")
else:
    print(f"Markers not found: start={start_idx}, end={end_idx}")
    sys.exit(1)
