<template>
	<div class="d-flex w-100 h-100 justify-content-center align-items-center">
		<div class="room-card">
			<p class="room-title">Select any Room or create your own:</p>
			
			<button class="create-room-btn">
				Create Room
				<svg class="plus-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
					<line x1="12" y1="5" x2="12" y2="19"></line>
					<line x1="5" y1="12" x2="19" y2="12"></line>
				</svg>
			</button>
		</div>
	</div>
</template>

<style lang="scss" scoped>
/* the card itself */
.room-card {
	background-color: rgba(255, 255, 255, 0.15); /* translucent white background */
	border-radius: 16px;
	padding: 32px 40px;
	max-width: 400px;
	width: 100%;
	box-sizing: border-box;
	text-align: center;
	/* a light backdrop blur where the browser supports it */
	backdrop-filter: blur(10px); 
	-webkit-backdrop-filter: blur(10px);
}

/* text */
.room-title {
	color: #ffffff;
	font-size: 18px;
	font-weight: 400;
	margin-top: 0;
	margin-bottom: 24px;
	letter-spacing: 0.3px;
}

/* button */
.create-room-btn {
	background-color: transparent;
	border: 1px solid rgba(255, 255, 255, 0.5);
	border-radius: 10px;
	color: #ffffff;
	font-size: 16px;
	padding: 14px 20px;
	width: 100%;
	cursor: pointer;
	display: flex;
	justify-content: center;
	align-items: center;
	gap: 12px; /* gap between the text and the icon */
	transition: background-color 0.2s ease, border-color 0.2s ease;
}

/* button hover */
.create-room-btn:hover {
	background-color: rgba(255, 255, 255, 0.1);
	border-color: rgba(255, 255, 255, 0.8);
}

/* icon alignment */
.plus-icon {
	display: block;
}
</style>

<script setup>
</script>